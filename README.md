# Water Heat Loss Simulator

An interactive browser simulation of a container of hot water cooling down.

- **Controls:** starting water temperature, room temperature, container shape
  (mug, wide dish, tall column, cube, sphere), size (50 mL – 20 L), material
  (glass, ceramic, plastic, stainless steel, aluminium, copper, polystyrene foam,
  vacuum-insulated steel), wall thickness (0.5 – 20 mm), lid on/off, and
  pre-heating the container.
- **Visuals:** a cut-away view where the water, walls and lid are coloured by
  temperature, with steam, condensation under the lid and heat-flow arrows
  labelled in watts.
- **Time controls:** play/pause, reset, speeds from real time up to 3 hours per
  second, and +10 min / +1 h jumps.
- **Readouts and chart:** cooling rate, heat loss, energy lost, water
  evaporated, time taken to reach 60 °C and 40 °C, a breakdown of where the heat
  goes, and a temperature-vs-time chart. Use "Keep this curve" to compare runs.

## Running it

No build step or install is needed. Open `index.html` in a browser, or serve
the folder:

```sh
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Hosting on GitHub Pages

The workflow in `.github/workflows/pages.yml` publishes the site every time
`main` is updated. You only need to set it up once:

1. On GitHub, open the repository's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Merge into `main`, or run the workflow by hand from the **Actions** tab.

The site will then be live at
`https://<your-username>.github.io/water-simulator-heat-loss/`.

## Project layout

| File | What it does |
| --- | --- |
| `js/physics.js` | The heat-transfer model. It has no DOM code, so it also runs in Node. |
| `js/renderer.js` | Draws the container, water, steam and arrows on a canvas. |
| `js/chart.js` | Draws the temperature-over-time chart. |
| `js/main.js` | Connects the controls to the model and runs the animation loop. |
| `css/style.css` | Layout, with light and dark themes and a phone layout. |

## How the physics works

The model is a small **lumped thermal network**. The water has one
temperature, and each wall panel (side, bottom, lid) has its own:

```
water ─► side wall ─► room
      ─► bottom    ─► room
      ─► lid       ─► room          (lid on)
      ─► room directly              (lid off: convection + radiation + evaporation)
```

- **Through the walls:** heat passes through a water "film" on the inside
  (natural convection in water), then through the wall material by conduction
  (`k / thickness`), then off the outside by natural convection in air and by
  thermal radiation (`ε σ T⁴`). Each panel also **stores heat**, so a thick cold
  ceramic mug takes a lot of heat from the water at the start. Pre-heating the
  container removes that effect.
- **Open top:** the water surface loses heat by convection, radiation and
  **evaporation**. Evaporation uses the heat/mass-transfer (Lewis) analogy with
  50% room humidity, and is usually the largest loss for hot, open water. The
  evaporated water is subtracted from the water mass.
- **Lid:** water evaporates, then condenses on the underside of the lid, which
  carries heat very well. That's why lids get hot, but the lid's outside still
  loses heat much more slowly than an open water surface.
- **Integration:** explicit Euler steps. The step size adapts to the fastest
  responding panel (a thin copper wall reacts in seconds), so high time speeds
  stay stable.

Simplifications: still air, the whole water volume is at one temperature, the
bottom loses heat into air rather than into the table, and walls are treated as
thin compared with the container. The results are realistic enough to compare
setups. For example, a 300 mL ceramic mug cools from 85 °C to 60 °C in about 13
minutes, while a lidded vacuum flask is still around 55 °C after 24 hours. It is
not a precise engineering tool.
