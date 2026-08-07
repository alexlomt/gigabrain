# Benchmark evidence

Gigabrain does not claim state of the art and does not publish a score from a private deployment as if it were a public benchmark.

The current public aggregate covers one 30-query development regression set used to select the answer-shape recall change in `0.9.0`:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Accuracy | 0.1667 | 0.2333 |
| Hit at k | 0.3667 | 0.4000 |
| MRR | 0.2115 | 0.2800 |
| Preference score | 0.6000 | 0.8000 |

The result supports one narrow statement: on this development fixture, routing duration/completion/certification questions toward answer-shaped evidence improved all four recorded metrics. It does not establish general recall quality, cross-dataset transfer, statistical significance, or superiority to another memory system.

Important limitations:

- only 30 queries
- development set, not held out
- candidate selected on the same set
- no frontier-model or external-system comparison
- sanitized aggregate only; raw private queries and memories are not released

The machine-readable aggregate is [benchmark-evidence.json](benchmark-evidence.json). Any future headline claim requires a reproducible public dataset, frozen code/config, independent rerun, and a held-out result.
