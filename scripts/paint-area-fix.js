/**
 * Grid-cell picker fix — Place Climbable Rocks / Place Waterfall / Door destination
 * --------------------------------------------------------------------------------
 * pokemon-assets' "Place Climbable Rocks" and "Place Waterfall" region tools, and
 * DGA's Door "pick location" button, all ask for a second cell through DGA's
 * api.scripts.UserPaintArea. That uses DGA's PainterTemplate, a MeasuredTemplate
 * subclass that:
 *   1. overrides _draw without building the parts core's refresh code expects
 *      (an exception thrown there repeats every frame and stalls the canvas
 *      ticker — token animations stop);
 *   2. switches layers back inside the confirming mousedown, so the same click
 *      continues into the Region layer with a non-region tool active.
 *
 * This replaces UserPaintArea with a self-contained picker: a PIXI square on the
 * controls layer, no template document, no layer switching. Clicks on the canvas
 * are captured at the window and never reach Foundry's canvas handlers; clicks on
 * the UI pass through untouched.
 *
 * Contract kept identical: resolves { x, y } (cell top-left, DGA's snapToGrid
 * without isTile), REJECTS on right-click / Escape — pokemon-assets relies on
 * the rejection (`.catch(() => src)`) to abort cleanly.
 *
 * No-op unless DGA is active.
 */

const MODULE_ID = "PTRe1-Adjustment-Modules";
const DGA = "dylans-general-automations";
const POKEMON_ASSETS = "pokemon-assets";

function cellAt(point) {
  const { sizeX, sizeY } = canvas.grid;
  return {
    x: Math.floor(point.x / sizeX) * sizeX,
    y: Math.floor(point.y / sizeY) * sizeY,
  };
}

function UserPaintArea() {
  return new Promise((resolve, reject) => {
    if (!canvas?.ready) return reject(new Error("Canvas not ready"));
    const view = canvas.app.view;
    const { sizeX, sizeY } = canvas.grid;
    const color = Number(game.user.color ?? 0xffffff);

    const marker = new PIXI.Graphics();
    (canvas.controls ?? canvas.interface).addChild(marker);
    const draw = ({ x, y }) => {
      marker.clear()
        .lineStyle(3, color, 0.9)
        .beginFill(color, 0.25)
        .drawRect(x, y, sizeX, sizeY)
        .endFill();
    };
    const fromEvent = (e) => cellAt(canvas.canvasCoordinatesFromClient({ x: e.clientX, y: e.clientY }));
    draw(cellAt(canvas.mousePosition ?? { x: 0, y: 0 }));

    let swallowUp = false;
    const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };

    const onMove = (e) => { if (e.target === view) draw(fromEvent(e)); };
    const onDown = (e) => {
      if (e.target !== view) return; // UI clicks pass through
      block(e);
      swallowUp = true;
      if (e.button === 0) finish(true, fromEvent(e));
      else if (e.button === 2) finish(false);
    };
    const onUp = (e) => { if (swallowUp) { swallowUp = false; block(e); } };
    // Compat mouse events and the context menu must not reach the canvas either.
    const onCanvasOnly = (e) => { if (e.target === view) block(e); };
    const onKey = (e) => { if (e.key === "Escape") { block(e); finish(false); } };
    const onTearDown = () => finish(false);

    const listeners = [
      ["pointermove", onMove], ["pointerdown", onDown], ["pointerup", onUp],
      ["mousedown", onCanvasOnly], ["mouseup", onCanvasOnly], ["contextmenu", onCanvasOnly],
      ["keydown", onKey],
    ];

    let done = false;
    function finish(ok, cell) {
      if (done) return;
      done = true;
      for (const [type, fn] of listeners) window.removeEventListener(type, fn, { capture: true });
      Hooks.off("canvasTearDown", onTearDown);
      marker.destroy();
      if (ok) resolve(cell);
      else reject();
    }

    for (const [type, fn] of listeners) window.addEventListener(type, fn, { capture: true });
    Hooks.once("canvasTearDown", onTearDown);
  });
}

function install() {
  if (!game.modules.get(DGA)?.active) return;
  for (const id of [DGA, POKEMON_ASSETS]) {
    const scripts = game.modules.get(id)?.api?.scripts;
    if (scripts && scripts.UserPaintArea !== UserPaintArea) scripts.UserPaintArea = UserPaintArea;
  }
}

// setup: after DGA's init registration. ready: again, in case pokemon-assets copied
// DGA's scripts into its own api after setup (registerAfterDependencies is async).
Hooks.once("setup", install);
Hooks.once("ready", () => {
  install();
  if (game.modules.get(DGA)?.active) console.log(`${MODULE_ID} | Replaced DGA UserPaintArea with the canvas-safe picker.`);
});
