# Contributing to EnvoraSports

Contributions are welcome!

1. Open an issue first for major modeling, data-provider, or schema changes.
2. Fork the repository and create a feature branch from `main`.
3. Before opening a PR, run:
   ```bash
   npm run typecheck && npm run lint && npm run test
   ```
4. Preserve the **no-leakage** invariant: every feature and query must respect knowledge cutoffs.
5. Never commit `.env`, API keys, or temporary scratch scripts.
