/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  Assert,
  displayIronAmountWithCurrency,
  IronfishRpcClient,
  ironToOre,
  isValidAmount,
  MINIMUM_IRON_AMOUNT,
  oreToIron,
  WebApi,
} from '@ironfish/sdk'
import { CliUx, Flags } from '@oclif/core'
import { IronfishCommand } from '../command'
import { RemoteFlags } from '../flags'

const REGISTER_URL = 'https://testnet.ironfish.network/signup'
// TODO: Fetch from API
const BANK_PUBLIC_ADDRESS = 'asdf'
const IRON_TO_SEND = 0.1

export default class Bank extends IronfishCommand {
  static description = 'Deposit $IRON for testnet points'

  client: IronfishRpcClient | null = null
  api: WebApi | null = new WebApi()

  static flags = {
    ...RemoteFlags,
    fee: Flags.integer({
      char: 'f',
      default: 1,
      description: `the fee amount in ORE, minimum of 1. 1 ORE is equal to ${MINIMUM_IRON_AMOUNT} IRON`,
    }),
    expirationSequence: Flags.integer({
      char: 'e',
      description: 'max number of blocks for the transaction to wait before expiring',
    }),
    account: Flags.string({
      char: 'a',
      default: 'default',
      parse: (input) => Promise.resolve(input.trim()),
      description: 'the account to send money from',
    }),
    confirm: Flags.boolean({
      default: false,
      description: 'confirm without asking',
    }),
  }

  async start(): Promise<void> {
    const { flags } = await this.parse(Bank)
    const fee = flags.fee
    const feeInIron = oreToIron(fee)
    const accountName = flags.account
    const expirationSequence = flags.expirationSequence

    this.client = await this.sdk.connectRpc()
    this.api = new WebApi()

    const { canSend, errorReason } = await this.verifyCanSend(flags)
    if (!canSend) {
      Assert.isNotNull(errorReason)
      this.log(errorReason)
      this.exit(1)
    }

    const balanceResp = await this.client.getAccountBalance()
    const newBalance = oreToIron(
      Number(balanceResp.content.confirmed) - IRON_TO_SEND - feeInIron,
    )

    const displayAmount = displayIronAmountWithCurrency(IRON_TO_SEND, true)
    const displayFee = displayIronAmountWithCurrency(feeInIron, true)
    const displayNewBalance = displayIronAmountWithCurrency(newBalance, true)
    if (!flags.confirm) {
      this.log(`
You are about to send ${displayAmount} plus a transaction fee of ${displayFee} to the Iron Fish deposit account.
Your remaining balance after this transaction will be ${displayNewBalance}.

* This action is NOT reversible *
      `)

      const confirm = await CliUx.ux.confirm('Do you confirm (Y/N)?')
      if (!confirm) {
        this.log('Transaction aborted.')
        this.exit(0)
      }
    }

    const result = await this.client.sendTransaction({
      fromAccountName: accountName,
      receives: [
        {
          publicAddress: BANK_PUBLIC_ADDRESS,
          amount: ironToOre(IRON_TO_SEND).toString(),
          memo: this.sdk.config.get('blockGraffiti'),
        },
      ],
      fee: fee.toString(),
      expirationSequence: expirationSequence,
    })
  }

  private async verifyCanSend(
    flags: Record<string, unknown>,
  ): Promise<{ canSend: boolean; errorReason: string | null }> {
    Assert.isNotNull(this.client)
    Assert.isNotNull(this.api)

    const status = await this.client.status()
    if (!status.content.blockchain.synced) {
      return {
        canSend: false,
        errorReason: `Your node must be synced with the Iron Fish network to send a transaction. Please try again later`,
      }
    }

    const graffiti = this.sdk.config.get('blockGraffiti')
    if (!graffiti) {
      return {
        canSend: false,
        errorReason: `No graffiti found. Register at ${REGISTER_URL} then run \`ironfish testnet\` to configure your node`,
      }
    }
    const user = await this.api.findUser({ graffiti })
    if (!user) {
      return {
        canSend: false,
        errorReason: `Graffiti not registered. Register at ${REGISTER_URL} and try again`,
      }
    }

    const expirationSequence = flags.expirationSequence as number | undefined
    if (expirationSequence !== undefined && expirationSequence < 0) {
      return {
        canSend: false,
        errorReason: `Expiration sequence must be non-negative`,
      }
    }

    const fee = flags.fee as number
    if (!isValidAmount(fee)) {
      return {
        canSend: false,
        errorReason: `The minimum fee is ${displayIronAmountWithCurrency(
          MINIMUM_IRON_AMOUNT,
          false,
        )}`,
      }
    }

    return { canSend: true, errorReason: null }
  }
}
