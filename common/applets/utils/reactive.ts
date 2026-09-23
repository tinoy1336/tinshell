/** Minimal reactive value container shared by the backend pollers
 *  (battery.ts, network.ts). Subscribers fire on every set(); peek() reads the
 *  current value synchronously for draw functions. */
type Listener = () => void
type Unsub = () => void

export interface Reactive<T> {
  peek: () => T
  subscribe: (cb: Listener) => Unsub
}

export interface ReactiveStore<T> extends Reactive<T> {
  set: (v: T) => void
}

export function mkReactive<T>(initial: T): ReactiveStore<T> {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    peek: () => value,
    subscribe: (cb: Listener): Unsub => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    set: (v: T) => {
      value = v
      for (const cb of listeners) cb()
    },
  }
}
