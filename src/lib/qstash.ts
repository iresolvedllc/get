import { Receiver } from '@upstash/qstash'

import type { Env } from '../env'

/**
 * The QStash receiver, used to verify that a publish event really came from
 * QStash. Both signing keys are supplied so a rotation does not reject
 * in-flight messages.
 */
export function receiver(env: Env): Receiver {
  return new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  })
}
