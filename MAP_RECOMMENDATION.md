# Map Architecture

## Current Approach

Free Food Map uses **Leaflet**, clustered markers, and OpenStreetMap raster tiles. Location coordinates are stored in Cloudflare D1, so the browser does not geocode records or load the full dataset by default.

The public page begins with the initiative introduction. Opening the search workspace still makes no location request. Results are loaded only after someone:

1. searches by ZIP code,
2. shares their location for a nearby search, or
3. explicitly chooses **Show all**.

On phones, the result list opens first and the mapping library and tiles are deferred until the person selects the Map tab. This keeps the common search path fast and reduces database, worker, and tile traffic.

## Why Not Google Maps or ArcGIS

Google Maps is polished, but its billing model and API restrictions can make costs less predictable for a public-service project. ArcGIS is excellent for GIS analysis and enterprise workflows, but is heavier than this application needs for search, filters, location details, and community updates.

## Growth Path

The current stack is appropriate for hundreds or several thousand points. If the dataset or map traffic grows substantially, the next useful step is **MapLibre GL JS** with a vector-tile source such as PMTiles, Protomaps, or a managed low-cost provider. That change should be driven by measured traffic and rendering needs, not made preemptively.

Continue storing authoritative coordinates in D1, geocoding on the server, clustering in the browser, and keeping **Show all** as an explicit action.
