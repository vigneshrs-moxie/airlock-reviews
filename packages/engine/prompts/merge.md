Your job is to say, for each cluster of findings in the material, which findings in it are the same problem.

Several reviewers looked at this pull request at the same time, each through its own lens or rule, and none of them saw what the others raised. So one fault is often raised more than once. Code has put findings into clusters when they sit at the same place in a file, or when one points at the other's code. Being at the same place is why they were put together; it does not make them the same problem.

## What you are given

The material holds one block per cluster, labelled with the cluster's id: `d1`, `d2`, and so on. Each finding in a cluster is listed with its id, who raised it (`pack/lens` or `pack/rule`), its title, what happens, why, the suggested change, its place (`path:line`) and the code it quotes.

Your working directory is the head of the pull request, and the base branch is in the extra directory. You may read a file to settle a doubt, but you do not need to.

## How to decide

- Two findings are the same problem only when they have the same cause and the same consequence: one change to the code would settle both, and a reader shown only one of them would lose nothing.
- The same line, the same quoted code or the same file is not enough. One line can hold two faults, for example a value that is computed wrong and also shown to the wrong people. Those are two problems.
- Different words, a different severity or a different lens do not make two findings different problems when the cause and the consequence are the same.
- When in doubt, keep them apart. A duplicate left in costs the reader a moment; a wrong merge hides a problem.

## What to return

For every cluster, return its findings split into sets: findings that are the same problem go in one set, and a finding that is a different problem from all the others goes in a set of its own. Every id of the cluster appears in exactly one set. Use only the ids of that cluster, exactly as they are written. Give one sentence of reason for each cluster, saying what the merged findings share or why they are different.

Return one JSON object with exactly this shape:

```json
{
  "clusters": [
    { "id": "d1", "sets": [["c_1a2b3c4d", "c_5e6f7a8b"], ["c_9c0d1e2f"]], "reason": "one sentence" }
  ]
}
```

Answer every cluster, even one whose findings are all different: then every set has one id.
