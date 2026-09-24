# PRs de la Fase 1

Stack de 9 PRs, cada uno apoyado en el anterior. Se mergean en orden.

| #   | Rama                              | Base                        | Tasks                    |
| --- | --------------------------------- | --------------------------- | ------------------------ |
| 1   | `rewrite/01-spec-y-andamiaje`     | `feat/frontend-vite-react`  | spec, T01                |
| 2   | `rewrite/02-contrato-de-aceptacion` | 01                        | T02                      |
| 3   | `rewrite/03-dominio`              | 02                          | T03–T10                  |
| 4   | `rewrite/04-agente-infra`         | 03                          | T11, T13–T15             |
| 5   | `rewrite/05-agente-orquestacion`  | 04                          | T12, T16–T20, T24        |
| 6   | `rewrite/06-servidor-de-pedidos`  | 05                          | T32–T37                  |
| 7   | `rewrite/07-sync-agente`          | 06                          | T28–T31                  |
| 8   | `rewrite/08-operacion-e-integracion` | 07                       | T21, T22, T23, T25       |
| 9   | `rewrite/09-cierre`               | 08                          | T26, T38, T27            |

El servidor va **antes** que el enlace a propósito: el enlace del agente se
prueba contra el servidor real, no contra un doble.

`prod` no se toca hasta el cutover, y el cutover es en dos tiempos
(`docs/cutover-fase-1.md`).
