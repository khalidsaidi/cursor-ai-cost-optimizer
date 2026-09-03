# Map tiers to real models

The install ran the plugin's discovery without probing, so the tiers already point at models your account can run. To probe and pin the best model per tier (and refresh prices), start a **new chat** and run the `cco-init` skill:

```
/cco-init
```

You can also edit `.cursor/cco.json` (`modelOverrides`) and re-run it. The status bar item `CCO: on` shows the current mapping in its tooltip.
