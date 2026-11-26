# pg-yassinesabri-shl-operations-hub

The hub of the Larder operations estate: the warehouse work that turns a paid order into a
dispatched box. It holds the requirements, stories and designs for two repositories, `pg-yassinesabri-shl-orders-api`
and `pg-yassinesabri-shl-fulfilment-service`, and no application code. `pg-yassinesabri-shl-orders-api` belongs to the commerce hub too.
`pg-yassinesabri-shl-orders-api` is shared with the BAU team: the harness trunk is `bcg_main`, and the BAU team keeps
`main`. `pg-yassinesabri-shl-fulfilment-service` uses `main` as the harness trunk.

- `docs/architecture/`: the estate's decision records. Each one binds every repository listed here.
- `docs/standards/`: the engineering standards a design and its code follow.
- `docs/estate/overview.md`: what the estate is, part by part.

The work-item keys carry the prefix `OPS`.
