import { safe } from './safe';

export type Listener<Args extends any[]> = (...args: Args) => void;

type Node<Args extends any[]> = {
  prev?: Node<Args>;
  next?: Node<Args>;
  fn: Listener<Args>;
};

export type Subscription<Args extends any[]> = {
  notify: (...args: Args) => void;
  subscribe: (fn: Listener<Args>) => () => void;
};

export function createSubscription<Args extends any[]>(): Subscription<Args> {
  let first: Node<Args> | undefined;
  let last: Node<Args> | undefined;

  return {
    notify: safe((...args) => {
      let curr = first;

      while (curr) {
        curr.fn(...args);
        curr = curr.next;
      }
    }),

    subscribe(fn) {
      const node: Node<Args> = { fn };

      if (!first || !last) {
        first = node;
        last = node;
      } else {
        last.next = node;
        node.prev = last;
        last = node;
      }

      return () => {
        if (node.prev && node.next) {
          node.prev.next = node.next;
        } else if (node.prev) {
          last = node.prev;
          last.next = undefined;
        } else if (node.next) {
          first = node.next;
          first.prev = undefined;
        } else {
          first = undefined;
          last = undefined;
        }
      };
    },
  };
}
