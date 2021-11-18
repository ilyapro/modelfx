import { safe } from "./safe";

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

      if (last) {
        last.next = node;
        node.prev = last;
      } else {
        first = node;
      }
      last = node;

      return () => {
        if (node.prev) {
          node.prev.next = node.next;
        } else {
          first = node.next;
        }
        if (node.next) {
          node.next.prev = node.prev;
        } else {
          last = node.prev;
        }
      };
    },
  };
}
