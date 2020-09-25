export type Listener = () => void;

type Node = { prev?: Node; next?: Node; fn: Listener };

export function createSubscription() {
  let first: Node | undefined;
  let last: Node | undefined;

  return {
    notify() {
      let curr = first;

      while (curr) {
        curr.fn();
        curr = curr.next;
      }
    },

    subscribe(fn: Listener) {
      const node: Node = { fn };

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
