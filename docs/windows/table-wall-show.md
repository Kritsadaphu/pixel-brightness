# Table + wall compatibility example

The canonical workflow is now the
[named-surface Windows show runbook](surface-mapping-show.md). It applies to any
number of named surfaces and every committed projector output. This filename is
retained for existing venue notes and links.

For the former two-surface example, use these logical records:

```json
[
  { "id": "surface-wall", "name": "Wall" },
  { "id": "surface-table", "name": "Table" }
]
```

Assign each output an explicit `wallId`, use zero overlap between Wall and
Table, and follow the generic freeze, Identify-all, content-restore, and
show-day acceptance gates. `walls` and `wallId` are historical schema names;
they represent generic named surfaces.

Manual mapping remains independent of camera calibration. Camera-derived mesh,
mask, or black correction is an optional later phase unless the show's separate
optical acceptance contract requires it.
