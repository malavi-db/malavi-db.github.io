/* =============================================================================
 * projection.mjs
 * -----------------------------------------------------------------------------
 * The Equal Earth projection, and the geometry the interactive map needs to
 * draw its basemap in it.
 *
 * WHY EQUAL EARTH
 *   The interactive map shows where MalAvi's records come from, and the first
 *   thing anyone reads off it is how unevenly the world has been sampled. Web
 *   Mercator, the default of every web map, inflates area toward the poles:
 *   Europe and North America, where most of the sampling is, are drawn several
 *   times too large against the tropics. An equal-area projection draws every
 *   region at its true share of the Earth's surface, so the density of points
 *   over a region can be compared with any other by eye.
 *
 *   Equal Earth (Savric, Patterson and Jenny 2019, Int. J. Geogr. Inf. Sci.
 *   33:454-465) is the equal-area projection designed for world maps: its
 *   outline resembles the familiar Robinson projection, its equations are
 *   closed-form, and it is in the public domain. The forward equations are the
 *   paper's; the inverse is the short Newton iteration the paper gives.
 *
 * WHAT IT COSTS
 *   It is not conformal. Away from the central meridian and the equator, shapes
 *   are sheared, most where the map's edges are (Alaska, eastern Siberia, New
 *   Zealand). The world cannot wrap: the map is cut at 180 degrees and there is
 *   no panning across the Pacific. That is why the page keeps Mercator one
 *   click away for regional zooming.
 *
 * Pure functions with no DOM and no Leaflet, so all of it runs under Node. See
 * tests/test_projection.mjs. The Leaflet coordinate system built on these is in
 * malavi.js, beside the map it serves.
 * ============================================================================= */

/* The four polynomial coefficients and the constant M = sqrt(3) / 2 of the
   paper's equations 8 to 10. */
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;

const RADIANS = Math.PI / 180;

/* The parametric latitude: sin(theta) = M * sin(phi). */
function thetaOf(latitudeRadians) {
  return Math.asin(M * Math.sin(latitudeRadians));
}

/* y as a function of theta, and its derivative. The derivative is also the
   denominator of x, which is what makes the projection equal-area. */
function yOfTheta(theta) {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return theta * (A1 + A2 * t2 + t6 * (A3 + A4 * t2));
}
function dyOfTheta(theta) {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2);
}

/**
 * Longitude and latitude in degrees to projected [x, y], for a sphere of radius
 * 1. x grows east, y grows NORTH. Latitude is clamped to the poles; longitude is
 * not clamped or wrapped, so a caller decides what a longitude past 180 means.
 */
export function equalEarthForward(longitude, latitude) {
  const phi = Math.max(-90, Math.min(90, latitude)) * RADIANS;
  const theta = thetaOf(phi);
  return [
    (longitude * RADIANS * Math.cos(theta)) / (M * dyOfTheta(theta)),
    yOfTheta(theta)
  ];
}

/**
 * Projected [x, y] back to [longitude, latitude] in degrees.
 *
 * theta is found from y by Newton's method (y is monotonic in theta and the
 * iteration converges in a handful of steps from theta = y / A1); longitude and
 * latitude then follow in closed form. y is clamped to the poles first, so a
 * point dragged above the top of the map reads as the pole rather than failing.
 */
export function equalEarthInverse(x, y) {
  const clamped = Math.max(-EQUAL_EARTH_Y_MAX, Math.min(EQUAL_EARTH_Y_MAX, y));
  let theta = clamped / A1;
  for (let i = 0; i < 12; i++) {
    const step = (yOfTheta(theta) - clamped) / dyOfTheta(theta);
    theta -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  const longitude = (M * x * dyOfTheta(theta)) / Math.cos(theta);
  const latitude = Math.asin(Math.max(-1, Math.min(1, Math.sin(theta) / M)));
  return [longitude / RADIANS, latitude / RADIANS];
}

/* The half-width of the map at the equator and its half-height at the poles,
   on the unit sphere. The world is 2 * X_MAX wide and 2 * Y_MAX tall, a ratio of
   about 2.05 to 1. */
export const EQUAL_EARTH_X_MAX = equalEarthForward(180, 0)[0];
export const EQUAL_EARTH_Y_MAX = equalEarthForward(0, 90)[1];

/* ---- geometry for the basemap -----------------------------------------------
   The site's basemap is country outlines in longitude and latitude. Two things
   have to happen to a ring before it can be drawn in a projection that does not
   wrap and whose meridians are curved. */

/**
 * Clip a ring of [longitude, latitude] vertices to the longitudes between
 * `west` and `east` (Sutherland-Hodgman against the two meridians).
 *
 * The basemap carries the countries that straddle the antimeridian twice, once
 * running past 180 E and once as a copy shifted by 360 degrees, so that a
 * wrapping map shows them whole on either side. A map cut at 180 needs neither
 * copy as it is: the first has to stop at the cut, and of the second only the
 * part that comes back in on the western edge belongs on the map. Clipping does
 * both, and returns an empty array for a ring that lies wholly outside.
 *
 * The ring may be closed (last vertex equal to the first) or open; the result
 * is open.
 */
export function clipRingToLongitudes(ring, west = -180, east = 180) {
  const clipAgainst = (points, inside, crossing) => {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const previous = points[(i + points.length - 1) % points.length];
      const currentIn = inside(current);
      const previousIn = inside(previous);
      if (currentIn !== previousIn) out.push(crossing(previous, current));
      if (currentIn) out.push(current);
    }
    return out;
  };
  /* Where the segment a-b crosses the meridian at `longitude`. */
  const at = (longitude) => (a, b) => {
    const t = (longitude - a[0]) / (b[0] - a[0]);
    return [longitude, a[1] + t * (b[1] - a[1])];
  };

  let points = ring.slice();
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  points = clipAgainst(points, (p) => p[0] >= west, at(west));
  points = clipAgainst(points, (p) => p[0] <= east, at(east));
  return points.length >= 3 ? points : [];
}

/**
 * Add vertices along any edge longer than `maxStep` degrees.
 *
 * A polygon edge is drawn as a straight line between its two projected ends.
 * That is right for a short edge and wrong for a long one: the cut along the
 * antimeridian is a straight line in longitude and latitude and a curve on this
 * map, and drawn from its two ends alone it would cut the corner. Inserting
 * vertices every few degrees makes the drawn edge follow the true one.
 *
 * The ring is treated as closed; the result is open (no repeated first vertex).
 */
export function densifyRing(ring, maxStep = 2) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    out.push(a);
    const span = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    const pieces = Math.ceil(span / maxStep);
    for (let k = 1; k < pieces; k++) {
      const t = k / pieces;
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

/**
 * The outline of the whole map, as a ring of [longitude, latitude]: up the
 * eastern edge at 180, across the north pole, down the western edge at -180,
 * and back across the south pole. Drawn under the land, it is the ocean, and
 * its edge is the edge of the world on this map.
 */
export function worldOutline(step = 2) {
  const ring = [];
  for (let latitude = -90; latitude <= 90; latitude += step) ring.push([180, latitude]);
  for (let latitude = 90; latitude >= -90; latitude -= step) ring.push([-180, latitude]);
  return ring;
}
