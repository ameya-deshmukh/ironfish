/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { blake3 } from '@napi-rs/blake-hash'
import { Assert } from '../assert'
import { createRootLogger, Logger } from '../logger'
import { Meter } from '../metrics/meter'
import { Target } from '../primitives/target'
import { IronfishIpcClient } from '../rpc/clients'
import { SerializedBlockTemplate } from '../serde/BlockTemplateSerde'
import { BigIntUtils } from '../utils/bigint'
import { ErrorUtils } from '../utils/error'
import { FileUtils } from '../utils/file'
import { SetTimeoutToken } from '../utils/types'
import { MiningPoolShares } from './poolShares'
import { StratumServer, StratumServerClient } from './stratum/stratumServer'
import { mineableHeaderString } from './utils'

const RECALCULATE_TARGET_TIMEOUT = 10000

export class MiningPool {
  readonly stratum: StratumServer
  readonly rpc: IronfishIpcClient
  readonly logger: Logger
  readonly shares: MiningPoolShares

  private started: boolean
  private stopPromise: Promise<void> | null = null
  private stopResolve: (() => void) | null = null

  private connectWarned: boolean
  private connectTimeout: SetTimeoutToken | null

  // TODO: Rename to job id or something
  nextMiningRequestId: number
  // TODO: LRU
  miningRequestBlocks: Map<number, SerializedBlockTemplate>

  difficulty: bigint
  target: Buffer

  currentHeadTimestamp: number | null
  currentHeadDifficulty: bigint | null

  recalculateTargetInterval: SetTimeoutToken | null

  constructor(options: { rpc: IronfishIpcClient; shares: MiningPoolShares; logger?: Logger }) {
    this.rpc = options.rpc
    this.logger = options.logger ?? createRootLogger()
    this.stratum = new StratumServer({ pool: this, logger: this.logger })
    this.shares = options.shares
    this.nextMiningRequestId = 0
    this.miningRequestBlocks = new Map()
    this.currentHeadTimestamp = null
    this.currentHeadDifficulty = null

    // Difficulty is set to the expected hashrate that would achieve 1 valid share per second
    // Ex: 100,000,000 would mean a miner with 100 mh/s would submit a valid share on average once per second
    // TODO: I think we should set it so that an 'average desktop' might only check-in once ever 5-10 minutes
    this.difficulty = BigInt(1_850_000) * 2n
    const basePoolTarget = BigInt(2n ** 256n / this.difficulty)
    this.target = BigIntUtils.toBytesBE(basePoolTarget, 32)

    this.connectTimeout = null
    this.connectWarned = false
    this.started = false

    this.recalculateTargetInterval = null
  }

  static async init(options: { rpc: IronfishIpcClient; logger?: Logger }): Promise<MiningPool> {
    const shares = await MiningPoolShares.init()
    return new MiningPool({
      rpc: options.rpc,
      logger: options.logger,
      shares,
    })
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    this.stopPromise = new Promise((r) => (this.stopResolve = r))
    this.started = true
    await this.shares.start()

    this.logger.info('Starting stratum server...')
    this.stratum.start()

    this.logger.info('Connecting to node...')
    this.rpc.onClose.on(this.onDisconnectRpc)
    void this.startConnectingRpc()
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return
    }

    this.logger.debug('Stopping pool, goodbye')

    this.started = false
    this.rpc.onClose.off(this.onDisconnectRpc)
    this.rpc.close()
    this.stratum.stop()

    await this.shares.stop()

    if (this.stopResolve) {
      this.stopResolve()
    }

    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout)
    }

    if (this.recalculateTargetInterval) {
      clearInterval(this.recalculateTargetInterval)
    }
  }

  async waitForStop(): Promise<void> {
    await this.stopPromise
  }

  getTarget(): string {
    return this.target.toString('hex')
  }

  async submitWork(
    client: StratumServerClient,
    miningRequestId: number,
    randomness: number,
    graffiti: Buffer,
  ): Promise<void> {
    Assert.isNotNull(client.publicAddress)
    if (miningRequestId !== this.nextMiningRequestId - 1) {
      this.logger.debug(
        `Client ${client.id} submitted work for stale mining request: ${miningRequestId}`,
      )
      return
    }

    const blockTemplate = this.miningRequestBlocks.get(miningRequestId)

    if (!blockTemplate) {
      this.logger.warn(
        `Client ${client.id} work for invalid mining request: ${miningRequestId}`,
      )
      return
    }

    blockTemplate.header.graffiti = graffiti.toString('hex')
    blockTemplate.header.randomness = randomness

    const headerBytes = mineableHeaderString(blockTemplate.header)
    const hashedHeader = blake3(headerBytes)

    if (hashedHeader < Buffer.from(blockTemplate.header.target, 'hex')) {
      this.logger.debug('Valid block, submitting to node')

      const result = await this.rpc.submitBlock(blockTemplate)

      if (result.content.added) {
        this.logger.info(
          `Block submitted successfully! ${FileUtils.formatHashRate(
            this.estimateHashRate(),
          )}/s`,
        )
      } else {
        this.logger.info(`Block was rejected: ${result.content.reason}`)
      }
    }

    if (hashedHeader < this.target) {
      this.logger.debug('Valid pool share submitted')
      await this.shares.submitShare(client.publicAddress, miningRequestId, randomness)
    }
  }

  private async startConnectingRpc(): Promise<void> {
    const connected = await this.rpc.tryConnect()

    if (!this.started) {
      return
    }

    if (!connected) {
      if (!this.connectWarned) {
        this.logger.warn(
          `Failed to connect to node on ${String(this.rpc.connection.mode)}, retrying...`,
        )
        this.connectWarned = true
      }

      this.connectTimeout = setTimeout(() => void this.startConnectingRpc(), 5000)
      return
    }

    this.connectWarned = false
    this.logger.info('Successfully connected to node')
    this.logger.info('Listening to node for new blocks')

    void this.processNewBlocks().catch(async (e: unknown) => {
      this.logger.error('Fatal error occured while processing blocks from node:')
      this.logger.error(ErrorUtils.renderError(e, true))
      await this.stop()
    })
  }

  private onDisconnectRpc = (): void => {
    this.stratum.waitForWork()

    this.logger.info('Disconnected from node unexpectedly. Reconnecting.')
    void this.startConnectingRpc()
  }

  private async processNewBlocks() {
    for await (const payload of this.rpc.blockTemplateStream().contentStream(true)) {
      Assert.isNotUndefined(payload.previousBlockInfo)
      this.restartCalculateTargetInterval()

      const currentHeadTarget = new Target(Buffer.from(payload.previousBlockInfo.target, 'hex'))
      this.currentHeadDifficulty = currentHeadTarget.toDifficulty()
      this.currentHeadTimestamp = payload.previousBlockInfo.timestamp

      this.distributeNewBlock(payload)
    }
  }

  private recalculateTarget() {
    Assert.isNotNull(this.currentHeadTimestamp)
    Assert.isNotNull(this.currentHeadDifficulty)

    const latestBlock = this.miningRequestBlocks.get(this.nextMiningRequestId - 1)
    Assert.isNotUndefined(latestBlock)

    const newTime = new Date()
    const newTarget = Target.fromDifficulty(
      Target.calculateDifficulty(
        newTime,
        new Date(this.currentHeadTimestamp),
        this.currentHeadDifficulty,
      ),
    )

    latestBlock.header.target = BigIntUtils.toBytesBE(newTarget.asBigInt(), 32).toString('hex')
    latestBlock.header.timestamp = newTime.getTime()
    this.distributeNewBlock(latestBlock)
  }

  private distributeNewBlock(newBlock: SerializedBlockTemplate) {
    Assert.isNotNull(this.currentHeadTimestamp)
    Assert.isNotNull(this.currentHeadDifficulty)

    const miningRequestId = this.nextMiningRequestId++
    this.miningRequestBlocks.set(miningRequestId, newBlock)

    this.stratum.newWork(miningRequestId, newBlock)
  }

  private restartCalculateTargetInterval() {
    if (this.recalculateTargetInterval) {
      clearInterval(this.recalculateTargetInterval)
    }

    this.recalculateTargetInterval = setInterval(() => {
      this.recalculateTarget()
    }, RECALCULATE_TARGET_TIMEOUT)
  }

  estimateHashRate(): number {
    // BigInt can't contain decimals, so multiply then divide by 100 to give 2 decimal precision
    return Number(BigInt(Math.floor(this.shares.shareRate() * 100)) * this.difficulty) / 100
  }
}
