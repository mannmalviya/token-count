# TODO

1. **Local timezone support.** Add an option to display timestamps in the
   user's local timezone instead of UTC. Surface this in both the CLI (flag
   or config) and the VSCode extension (setting).

2. **Share button for analytics.** Let users share their token-usage
   analytics with customizable content — pick which stats/charts are
   included and how they're presented. Targets: X, LinkedIn, Instagram,
   and an embeddable HTML snippet for dropping into a `.md` file.

3. **Fix first graph (project + model selection).** Currently, picking a
   project and then picking a model resets the view. Instead, it should
   show token usage for that specific model within that specific project.

4. **GitHub-style heatmap.** Add a heatmap (in the signature Claude Code
   orange instead of green) alongside the existing bar graph and line
   graph.
