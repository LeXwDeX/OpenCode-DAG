/**
 * Minimal Log shim for modules ported from v1.15.10.
 * v1.17.11 removed the core/util/log module; this shim preserves the
 * Log.create({service}) → { debug, info, warn, error } API so ported
 * code compiles unchanged.
 */

interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
  time(label: string, meta?: Record<string, unknown>): Disposable
}

const noopDisposable: Disposable = { [Symbol.dispose]() {} }

const noop: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  time: () => noopDisposable,
}

export function Log() {
  return noop
}

export const create = (_opts: { service: string }): Logger => noop

export const Default: Logger = noop
