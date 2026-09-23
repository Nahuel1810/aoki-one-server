# PRs de la Fase 1

Stack de 5 PRs, cada uno apoyado en el anterior. Se mergean en orden.

| # | Rama | Base | Tasks |
|---|---|---|---|
| 1 | `rewrite/01-spec-y-andamiaje` | `feat/frontend-vite-react` | spec, T01 |
| 2 | `rewrite/02-contrato-de-aceptacion` | 01 | T02 |
| 3 | `rewrite/03-dominio` | 02 | T03–T10 |
| 4 | `rewrite/04-agente-infra` | 03 | T11, T13–T15 |
| 5 | `rewrite/05-agente-orquestacion` | 04 | T12, T16–T20, T24 |

`prod` no se toca hasta el cutover (T26).
