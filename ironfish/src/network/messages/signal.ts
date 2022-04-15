/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import bufio from 'bufio'
import { Identity, identityLength } from '../identity'
import { nonceLength } from '../peers/encryption'
import { NetworkMessage, NetworkMessageType } from './networkMessage'

interface CreateSignalMessageOptions {
  destinationIdentity: Identity
  sourceIdentity: Identity
  nonce: string
  signal: string
}

/**
 * A message used to signal an rtc session between two peers.
 *
 * The referring peer will forward the message to the sourceIdentity,
 * which will need to respond with a signal that has peer and source
 * inverted.
 */
export class SignalMessage extends NetworkMessage {
  readonly sourceIdentity: Identity
  readonly destinationIdentity: Identity
  readonly nonce: string
  readonly signal: string

  constructor({
    destinationIdentity,
    sourceIdentity,
    nonce,
    signal,
  }: CreateSignalMessageOptions) {
    super(NetworkMessageType.Signal)
    this.destinationIdentity = destinationIdentity
    this.sourceIdentity = sourceIdentity
    this.nonce = nonce
    this.signal = signal
  }

  serialize(): Buffer {
    const bw = bufio.write(this.getSize())
    bw.writeBytes(Buffer.from(this.destinationIdentity, 'base64'))
    bw.writeBytes(Buffer.from(this.sourceIdentity, 'base64'))
    bw.writeBytes(Buffer.from(this.nonce, 'base64'))
    bw.writeBytes(Buffer.from(this.signal, 'base64'))
    return bw.render()
  }

  static deserialize(buffer: Buffer): SignalMessage {
    const reader = bufio.read(buffer, true)
    const destinationIdentity = reader.readBytes(identityLength).toString('base64')
    const sourceIdentity = reader.readBytes(identityLength).toString('base64')
    const nonce = reader.readBytes(nonceLength).toString('base64')
    const signal = reader.readBytes(reader.left()).toString('base64')
    return new SignalMessage({
      destinationIdentity,
      sourceIdentity,
      nonce,
      signal,
    })
  }

  getSize(): number {
    return (
      identityLength + identityLength + nonceLength + Buffer.byteLength(this.signal, 'base64')
    )
  }
}
