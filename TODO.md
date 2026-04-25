# TODO

1. ~~**Local timezone support.**~~ Shipped. Both surfaces now default to
   the machine's local timezone for day bucketing. CLI: `--utc` opts back
   to UTC. VSCode: `tokenCount.useLocalTimezone` setting (default true).

2. **Share button for analytics.** Let users share their token-usage
   analytics with customizable content — pick which stats/charts are
   included and how they're presented. Targets: X, LinkedIn, Instagram,
   and an embeddable HTML snippet for dropping into a `.md` file.

3. **Fix first graph (project + model selection).** Currently, picking a
   project and then picking a model resets the view. Instead, it should
   show token usage for that specific model within that specific project.
