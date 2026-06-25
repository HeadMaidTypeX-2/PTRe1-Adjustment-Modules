# PTU Table Toolkit

A small bundle of fixes for a **PTU** (system id `ptu`) world on **Foundry V13/V14**,
kept in one module so it installs and updates from one place.

> Module id is `ptr-capability-ruler` for historical continuity (it began as the
> ruler module). The title is broader because it now does more.

## What's inside

Three independent scripts, each its own file under `scripts/`:

1. **`ptr-capability-ruler.js`** — recolours the native token drag-ruler
   (green / yellow / red) based on the dragged token's movement capability for
   the selected Movement Action. *(Requires libWrapper.)*
2. **`aa-user-author-shim.js`** — restores `ChatMessage#user` as an alias of
   `ChatMessage#author`, which Foundry V14 removed. Without it, Automated
   Animations' PTU handler throws and animations never play. No-op on V13.
3. **`shop-description-fix.js`** — mirrors PTU's `system.effect` into the
   conventional `system.description.value` at derived-data time (in memory
   only — nothing is saved), so description-extracting modules like Stylish
   Shop can read item text. *(Requires libWrapper.)*

## Requirements

- Foundry VTT V13 or V14
- System: `ptu`
- [libWrapper](https://github.com/ruipin/fvtt-lib-wrapper) (declared as a required dependency)

## Install

In Foundry → **Add-on Modules → Install Module**, paste the manifest URL:

```
https://github.com/<YOUR-GITHUB-USERNAME>/ptr-capability-ruler/releases/latest/download/module.json
```

## First-time setup (IMPORTANT)

`scripts/ptr-capability-ruler.js` in this repo is a **placeholder**. Replace its
entire contents with your existing tuned ruler script from
`Data/modules/ptr-capability-ruler/scripts/ptr-capability-ruler.js`, then commit.

Also disable/remove the old separate modules once this is enabled, so nothing
registers twice: the standalone AA shim and the standalone shop-description-fix.

## Update workflow

Edit on your desktop, then publish a release the laptop's Foundry can see:

```bash
git add -A
git commit -m "Describe the change"
git tag v0.5.1        # bump the version
git push origin main --tags
```

The GitHub Action (`.github/workflows/release.yml`) stamps the version and the
manifest/download URLs into `module.json`, zips the module, and publishes a
release. In Foundry, **Manage Modules → Check for Updates** will then offer it.

## License

Your call — add a `LICENSE` file if you intend to share it.
