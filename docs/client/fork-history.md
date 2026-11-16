# Fork history

When two members commit at the same time, a group briefly forks into competing branches. Convergence picks one canonical branch automatically (see [fork retractions](/client/messages#handle-fork-retractions) for what your app must handle). The fork history tree lets you inspect those branches, which is mainly useful for debugging tools and diagnostic UIs. Ordinary chat apps don't need it.

Each node is one group state, identified by its MLS confirmation tag, and each edge is a commit. A node with more than one child is a fork:

```
        root (epoch 1)
        ├── A (epoch 2)   ← canonical tip (group.state)
        └── B (epoch 2)   ← abandoned branch
```

Only recent epochs are retained; older branches are pruned automatically.

## Render the tree

`group.forkTreeView()` returns a plain, serializable snapshot suitable for a UI:

```typescript
const view = group.forkTreeView();

view.canonicalTip; // the tip you send from
view.tips; // every tip, canonical and abandoned

for (const node of view.nodes) {
  node.tag; // node id
  node.epoch;
  node.parentTag; // undefined for the root
  node.childTags; // more than one means a fork here
  node.canonical; // on the path to the canonical tip
  node.commit?.digestHex; // the commit that produced this node
}
```

For ad-hoc queries, `group.forkTree` is the live tree, with methods such as `tips()`, `childrenOf(tag)`, `path(tag)`, `lowestCommonAncestor(a, b)`, and `await stateAt(tag)`. See the [API reference](pathname:///reference/index.html).

## React to changes

`historyChanged` fires whenever ingestion adds a node, even if the canonical state did not change:

```typescript
group.on("historyChanged", (g) => render(g.forkTreeView()));
```

::: warning Don't change the convergence policy in production
`MarmotClient` accepts a `convergencePolicy` option (for example, `maxRewindCommits: Infinity` to keep every branch). All members must use the same policy; a client with a different one can choose a different canonical branch and fork from the group. Only use it in test harnesses or forensic tools that never send to a real group.
:::
