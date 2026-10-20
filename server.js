const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const preferredPort = Number(process.env.PORT || 4173);
const cache = new Map();
const railNetwork = JSON.parse(fs.readFileSync(path.join(root, 'rail-network.json'), 'utf8'));
const railCalendars = new Map(railNetwork.calendar.map((row) => [row.service_id, row]));
const railExceptions = new Map(railNetwork.calendarDates.map((row) => [row.service_id + '|' + row.date, row.exception_type]));
const railStationIndex = new Map(railNetwork.stations.map(([id], index) => [id, index]));
const railStationSummary = railNetwork.stations.map(([id, name]) => ({ id, name }));
const railTripsByStation = new Map();
for (const trip of railNetwork.trips) {
  trip[4].forEach((stop, position) => {
    if (!railTripsByStation.has(stop[0])) railTripsByStation.set(stop[0], []);
    railTripsByStation.get(stop[0]).push({ trip, stop, position });
  });
}
const viennaOffsetCache = new Map();
const railLineStops = new Map();
const railLineDirections = new Map();
for (const trip of railNetwork.trips) {
  if (!railLineStops.has(trip[0])) railLineStops.set(trip[0], new Set());
  const sequence = [];
  for (const stop of trip[4]) {
    railLineStops.get(trip[0]).add(stop[0]);
    if (sequence[sequence.length - 1] !== stop[0]) sequence.push(stop[0]);
  }
  const directionKey = trip[0] + '|' + trip[2];
  const previous = railLineDirections.get(directionKey);
  if (!previous || sequence.length > previous.sequence.length) railLineDirections.set(directionKey, { line: trip[0], towards: trip[2] || 'Richtung unbekannt', sequence });
}
const mime = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  if (process.env.APP_PASSWORD && !authorized(req.headers.authorization)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Abfahrt privat", charset="UTF-8"', 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Anmeldung erforderlich.');
  }
  if (url.pathname === '/api/rail/stations') {
    const lines = Array.from(railLineStops, ([line, stopSet]) => ({
      line,
      stationCount: stopSet.size,
      directions: Array.from(railLineDirections.values()).filter((route) => route.line === line).map((route) => ({ towards: route.towards, stations: route.sequence.map((index) => railNetwork.stations[index][1]) }))
    }))
      .sort((a, b) => a.line.localeCompare(b.line, 'de', { numeric: true }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ stations: railStationSummary, lines, validThrough: railNetwork.validThrough }));
  }
  if (url.pathname === '/api/rail/departures') {
    const stationId = url.searchParams.get('station');
    if (!railStationIndex.has(stationId)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Bitte eine gültige Bahnstation auswählen.' }));
    }
    const now = new Date();
    const cutoff = now.getTime() + 70 * 60000;
    const today = viennaDate(now);
    const dates = [addServiceDays(today, -1), today, addServiceDays(today, 1)];
    const stopIndex = railStationIndex.get(stationId);
    const result = [];
    for (const serviceDate of dates) {
      for (const { trip, stop, position } of railTripsByStation.get(stopIndex) || []) {
        if (!railServiceRuns(trip[1], serviceDate)) continue;
        if (stop[4] === '1') continue;
        const timePlanned = scheduledIso(serviceDate, stop[2]);
        const timestamp = Date.parse(timePlanned);
        if (timestamp < now.getTime() || timestamp > cutoff) continue;
        const stops = trip[4].slice(position).map((routeStop) => ({
          name: railNetwork.stations[routeStop[0]][1],
          arrival: scheduledIso(serviceDate, routeStop[1]),
          departure: scheduledIso(serviceDate, routeStop[2]),
          platform: routeStop[3] || '—'
        }));
        result.push({ line: trip[0], towards: trip[2] || 'Richtung unbekannt', platform: stop[3] || '—', timePlanned, realtime: false, stops });
      }
    }
    const unique = new Map();
    for (const item of result) unique.set([item.line, item.towards, item.platform, item.timePlanned].join('|'), item);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ source: railNetwork.source, validThrough: railNetwork.validThrough, departures: Array.from(unique.values()).sort((a, b) => Date.parse(a.timePlanned) - Date.parse(b.timePlanned)) }));
  }
  if (url.pathname === '/api/connections') {
    const from = url.searchParams.get('from') || '';
    const to = url.searchParams.get('to') || '';
    const date = url.searchParams.get('date') || '';
    const time = url.searchParams.get('time') || '';
    const fromName = url.searchParams.get('fromName') || '';
    const toName = url.searchParams.get('toName') || '';
    if (!routeLocation(from, fromName) || !routeLocation(to, toName) || from === to || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Bitte Start, Ziel, Datum und Uhrzeit prüfen.' }));
    }
    try {
      const connections = await findNetworkConnections(from, fromName, to, toName, date, time);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ source: 'Wiener Linien / VOR Routing', fetchedAt: new Date().toISOString(), connections }));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Die Verbindungsauskunft ist gerade nicht erreichbar.', detail: error.message }));
    }
  }
  if (url.pathname === '/api/disruptions') {
    try {
      const upstream = await fetch('https://www.wienerlinien.at/ogd_realtime/trafficInfoList', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      if (!upstream.ok) throw new Error('Störungsinfo antwortet mit HTTP ' + upstream.status);
      const body = await upstream.json();
      const rows = body && body.data && body.data.trafficInfos || [];
      const now = Date.now();
      const active = rows.filter((item) => {
        const start = Date.parse(item.time && item.time.start || '');
        const end = Date.parse(item.time && item.time.end || '');
        return (!Number.isFinite(start) || start <= now) && (!Number.isFinite(end) || end >= now);
      }).map((item) => ({ title: item.title || 'Betriebsinformation', description: item.description || '', category: item.refTrafficInfoCategoryId, lines: (item.relatedLines || []).map((line) => line.name || line), stops: (item.relatedStops || []).map((stop) => stop.name || stop), start: item.time && item.time.start || '', end: item.time && item.time.end || '' }));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ source: 'Wiener Linien Verkehrsinformationen', fetchedAt: new Date().toISOString(), disruptions: active }));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Störungsinformationen gerade nicht erreichbar.', detail: error.message }));
    }
  }
  if (url.pathname === '/api/trip-stops') {
    const stationId = url.searchParams.get('station') || '';
    const line = url.searchParams.get('line') || '';
    const towards = url.searchParams.get('towards') || '';
    const fromName = url.searchParams.get('fromName') || '';
    const date = url.searchParams.get('date') || '';
    const time = url.searchParams.get('time') || '';
    if (!/^\d{5,10}$/.test(stationId) || !/^(?:U[1-6]|S\d+|REX\s?\d*)$/i.test(line) || !towards || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Fahrtenverlauf ist für diese Abfahrt nicht verfügbar.' }));
    }
    if (!/^U[1-6]$/i.test(line)) {
      const candidates = Array.from(railLineDirections.values()).filter((route) => route.line.toLocaleLowerCase('de') === line.toLocaleLowerCase('de'));
      const route = candidates.find((candidate) => candidate.towards.toLocaleLowerCase('de') === towards.toLocaleLowerCase('de')) || candidates[0];
      if (route) {
        let start = route.sequence.findIndex((index) => railNetwork.stations[index][1].toLocaleLowerCase('de').startsWith(fromName.toLocaleLowerCase('de')));
        if (start < 0) start = 0;
        const stops = route.sequence.slice(start).map((index) => ({ name: railNetwork.stations[index][1], arrival: '', departure: '', platform: '—' }));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ line, stops }));
      }
    }
    try {
      const params = new URLSearchParams({
        outputFormat: 'JSON', language: 'de', locationServerActive: '1', sessionID: '0',
        type_origin: 'stopID', name_origin: stationId, type_destination: 'any', name_destination: towards,
        itdDate: date.replaceAll('-', ''), itdTime: time.replace(':', ''), itdTripDateTimeDepArr: 'dep',
        calcNumberOfTrips: '5', maxChanges: '0', routeType: 'LEASTTIME'
      });
      const upstream = await fetch('https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2?' + params, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000)
      });
      if (!upstream.ok) throw new Error('Routing antwortet mit HTTP ' + upstream.status);
      const data = await upstream.json();
      const trips = Array.isArray(data.trips) ? data.trips : data.trips ? [data.trips] : [];
      const leg = trips.flatMap((trip) => trip.legs || []).find((item) => String(item.mode && (item.mode.number || item.mode.symbol)) === line);
      const stops = leg && leg.stopSeq || [];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ line, stops: stops.map((stop) => ({
        name: String(stop.nameWO || stop.name || '').replace(/^Wien\s+/i, ''),
        arrival: stop.arrDateTime || '', departure: stop.depDateTime || '', platform: stop.platformName || '—'
      })) }));
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Haltestellenfolge gerade nicht erreichbar.', detail: error.message }));
    }
  }
  if (url.pathname === '/api/departures') {
    const stopIds = Array.from(new Set(url.searchParams.getAll('stopId'))).sort();
    if (!stopIds.length || stopIds.length > 30 || stopIds.some((id) => !/^\d{1,7}$/.test(id))) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'Ungültige Stationsauswahl.' }));
    }
    const cacheKey = stopIds.join(',');
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.time < 4000) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(cached.body);
    }
    try {
      const query = stopIds.map((id) => 'stopId=' + encodeURIComponent(id)).join('&');
      const upstream = await fetch('https://www.wienerlinien.at/ogd_realtime/monitor?' + query, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(7000)
      });
      if (!upstream.ok) throw new Error('Wiener Linien antwortet mit HTTP ' + upstream.status);
      const body = await upstream.text();
      JSON.parse(body);
      cache.set(cacheKey, { time: Date.now(), body });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Echtzeitdaten gerade nicht erreichbar.', detail: error.message }));
    }
    return;
  }

  let file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(full, (error, data) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

function authorized(header) {
  const match = String(header || '').match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  let supplied;
  try { supplied = Buffer.from(match[1], 'base64').toString('utf8'); } catch (_) { return false; }
  const separator = supplied.indexOf(':');
  if (separator < 0) return false;
  return constantTimeEqual(supplied.slice(0, separator), process.env.APP_USER || '') &&
    constantTimeEqual(supplied.slice(separator + 1), process.env.APP_PASSWORD || '');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function viennaDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Vienna', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year + values.month + values.day;
}

function addServiceDays(date, amount) {
  const value = new Date(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10).replaceAll('-', '');
}

function railServiceRuns(serviceId, date) {
  const exception = railExceptions.get(serviceId + '|' + date);
  if (exception) return exception === '1';
  const calendar = railCalendars.get(serviceId);
  if (!calendar || date < calendar.start_date || date > calendar.end_date) return false;
  const weekday = new Date(date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6, 8) + 'T12:00:00Z').getUTCDay();
  return calendar[['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][weekday]] === '1';
}

function scheduledIso(serviceDate, time) {
  const seconds = typeof time === 'number' ? time : time.split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const date = new Date(serviceDate.slice(0, 4) + '-' + serviceDate.slice(4, 6) + '-' + serviceDate.slice(6, 8) + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + Math.floor(seconds / 86400));
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1, day = date.getUTCDate();
  const dateText = date.toISOString().slice(0, 10);
  const withinDay = seconds % 86400;
  let offset = viennaOffsetCache.get(dateText);
  if (offset == null) {
    const zone = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Vienna', timeZoneName: 'longOffset' }).formatToParts(new Date(dateText + 'T12:00:00Z')).find((part) => part.type === 'timeZoneName').value;
    const match = zone.match(/GMT([+-])(\d{2}):(\d{2})/);
    offset = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) * 60000 : 0;
    viennaOffsetCache.set(dateText, offset);
  }
  return new Date(Date.UTC(year, month - 1, day) + withinDay * 1000 - offset).toISOString();
}

function routeLocation(value, fallbackName) {
  if (value.startsWith('wl:')) return /^\d{5,10}$/.test(value.slice(3));
  if (value.startsWith('rail:')) return /^Pat:\d+:\d+$/.test(value.slice(5)) || Boolean(fallbackName.trim());
  return false;
}

function routingPoint(value, fallbackName, role, params) {
  if (value.startsWith('wl:')) {
    params.set('type_' + role, 'stopID');
    params.set('name_' + role, value.slice(3));
    return;
  }
  const stationId = value.slice(5);
  const match = stationId.match(/^Pat:\d+:(\d+)$/);
  if (match) {
    params.set('type_' + role, 'stopID');
    params.set('name_' + role, '602' + match[1].padStart(5, '0'));
  } else {
    params.set('type_' + role, 'any');
    params.set('name_' + role, fallbackName);
  }
}

function routeDateTime(point, live) {
  if (!point || !point.dateTime) return '';
  const dateTime = point.dateTime;
  const dateText = live && dateTime.rtDate || dateTime.date;
  const timeText = live && dateTime.rtTime || dateTime.time;
  if (dateText && timeText) {
    const match = dateText.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (match && timeMatch) {
      const seconds = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3] || 0);
      return scheduledIso(match[3] + match[2] + match[1], seconds);
    }
  }
  const stamp = point.stamp || {};
  const stampDate = live && stamp.rtDate || stamp.date;
  const stampTime = live && stamp.rtTime || stamp.time;
  if (!/^\d{8}$/.test(stampDate || '') || !/^\d{1,6}$/.test(stampTime || '')) return '';
  const digits = String(stampTime);
  const padded = digits.padStart(digits.length <= 4 ? 4 : 6, '0');
  const seconds = Number(padded.slice(0, 2)) * 3600 + Number(padded.slice(2, 4)) * 60 + Number(padded.slice(4, 6) || 0);
  return scheduledIso(stampDate, seconds);
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (value.point) return Array.isArray(value.point) ? value.point : [value.point];
  if (value.leg) return Array.isArray(value.leg) ? value.leg : [value.leg];
  return [value];
}

async function findNetworkConnections(from, fromName, to, toName, date, time) {
  const params = new URLSearchParams({
    outputFormat: 'JSON', language: 'de', locationServerActive: '1', sessionID: '0',
    itdDate: date.replaceAll('-', ''), itdTime: time.replace(':', ''), itdTripDateTimeDepArr: 'dep',
    ptOptionsActive: '1', changeSpeed: 'slow',
    calcNumberOfTrips: '10', routeType: 'LEASTTIME', coordOutputFormat: 'WGS84[DD.ddddd]'
  });
  routingPoint(from, fromName, 'origin', params);
  routingPoint(to, toName, 'destination', params);
  const response = await fetch('https://www.wienerlinien.at/ogd_routing/XML_TRIP_REQUEST2?' + params, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Routing antwortet mit HTTP ' + response.status);
  const data = await response.json();
  const trips = asArray(data.trips && (data.trips.trip || data.trips));
  const [hour, minute] = time.split(':').map(Number);
  const requested = Date.parse(scheduledIso(date.replaceAll('-', ''), hour * 3600 + minute * 60));
  return trips.map((trip) => {
    const legs = asArray(trip.legs && (trip.legs.leg || trip.legs)).map((item) => {
      const points = asArray(item.points && (item.points.point || item.points));
      const departure = points.find((point) => point.usage === 'departure') || points[0];
      const arrival = points.find((point) => point.usage === 'arrival') || points[points.length - 1];
      const mode = item.mode || {};
      const realtime = String(mode.realtime) === '1';
      const plannedDeparture = routeDateTime(departure, false);
      const predictedDeparture = routeDateTime(departure, realtime);
      const plannedArrival = routeDateTime(arrival, false);
      const predictedArrival = routeDateTime(arrival, realtime);
      const stopSeq = asArray(item.stopSeq && (item.stopSeq.stop || item.stopSeq));
      const firstStop = stopSeq[0] || {};
      const lastStop = stopSeq[stopSeq.length - 1] || {};
      const name = (point) => String(point && (point.nameWithPlace || point.name || point.nameWO) || '').replace(/^Wien\s+/i, '');
      const stops = stopSeq.map((stop) => {
        const reference = stop.ref || {};
        return {
          name: name(stop),
          arrival: reference.arrDateTime || stop.arrDateTime || '',
          departure: reference.depDateTime || stop.depDateTime || '',
          platform: stop.platformName || reference.platform || '—'
        };
      }).filter((stop) => stop.name);
      return {
        line: mode.number || mode.symbol || mode.name || 'Fußweg',
        trainName: mode.name || mode.product || mode.number || 'Verkehrsmittel',
        destination: String(mode.destination || '').replace(/^Wien\s+/i, ''),
        serviceCode: mode.diva && mode.diva.tripCode ? String(mode.diva.tripCode) : '',
        from: name(firstStop) || name(departure), to: name(lastStop) || name(arrival),
        stops,
        departure: predictedDeparture || plannedDeparture, arrival: predictedArrival || plannedArrival,
        delayMinutes: realtime && plannedDeparture && predictedDeparture ? Math.round((Date.parse(predictedDeparture) - Date.parse(plannedDeparture)) / 60000) : null,
        platformFrom: departure && (departure.plannedPlatformName || departure.platformName) || '—',
        platformTo: arrival && (arrival.plannedPlatformName || arrival.platformName) || '—',
        realtime
      };
    }).filter((leg) => leg.departure && leg.arrival);
    if (!legs.length) return null;
    const interchangeCount = Number(trip.interchange);
    return {
      legs, departure: legs[0].departure, arrival: legs[legs.length - 1].arrival,
      changes: Number.isFinite(interchangeCount) && interchangeCount >= 0 ? interchangeCount : Math.max(0, legs.length - 1),
      durationMinutes: Math.round((Date.parse(legs[legs.length - 1].arrival) - Date.parse(legs[0].departure)) / 60000),
      realtime: legs.some((leg) => leg.realtime)
    };
  }).filter((journey) => journey && Date.parse(journey.departure) >= requested)
    .sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival) || a.changes - b.changes || Date.parse(a.departure) - Date.parse(b.departure));
}

function findRailConnections(from, to, date, time) {
  const cleanDate = date.replaceAll('-', '');
  const [hour, minute] = time.split(':').map(Number);
  const requested = Date.parse(scheduledIso(cleanDate, hour * 3600 + minute * 60));
  const latestStart = requested + 8 * 60 * 60000;
  const schedules = [];
  for (const offset of [-1, 0, 1]) {
    const serviceDate = addServiceDays(cleanDate, offset);
    for (const packed of railNetwork.trips) {
      if (!railServiceRuns(packed[1], serviceDate)) continue;
      const stops = packed[4].map((stop) => ({ station: stop[0], arrival: Date.parse(scheduledIso(serviceDate, stop[1])), departure: Date.parse(scheduledIso(serviceDate, stop[2])), platform: stop[3] || '—', pickup: stop[4], dropoff: stop[5] }));
      schedules.push({ line: packed[0], headsign: packed[2], train: packed[3], stops });
    }
  }

  const departures = new Map();
  for (const trip of schedules) trip.stops.forEach((stop, position) => {
    if (stop.pickup === '1') return;
    if (!departures.has(stop.station)) departures.set(stop.station, []);
    departures.get(stop.station).push({ trip, position, time: stop.departure });
  });
  for (const options of departures.values()) options.sort((a, b) => a.time - b.time);
  const journeys = new Map();
  const stationName = (index) => railNetwork.stations[index][1];
  const leg = (trip, start, end) => ({
    line: trip.line, train: trip.train, from: stationName(trip.stops[start].station), to: stationName(trip.stops[end].station),
    departure: new Date(trip.stops[start].departure).toISOString(), arrival: new Date(trip.stops[end].arrival).toISOString(),
    platformFrom: trip.stops[start].platform, platformTo: trip.stops[end].platform
  });
  const addJourney = (legs) => {
    const key = legs.map((item) => item.line + ':' + item.departure + ':' + item.arrival).join('|');
    if (journeys.has(key)) return;
    journeys.set(key, { legs, departure: legs[0].departure, arrival: legs[legs.length - 1].arrival, changes: legs.length - 1,
      durationMinutes: Math.round((Date.parse(legs[legs.length - 1].arrival) - Date.parse(legs[0].departure)) / 60000) });
  };

  const firstOptions = (departures.get(from) || []).filter((item) => item.time >= requested && item.time <= latestStart).slice(0, 240);
  for (const first of firstOptions) {
    const firstTrip = first.trip;
    for (let end = first.position + 1; end < firstTrip.stops.length; end++) {
      const reached = firstTrip.stops[end];
      if (reached.arrival > latestStart + 5 * 60 * 60000) break;
      if (reached.dropoff !== '1' && reached.station === to) addJourney([leg(firstTrip, first.position, end)]);
      if (reached.dropoff === '1') continue;
      if (reached.station === from || reached.station === to) continue;
      const connections = (departures.get(reached.station) || []).filter((candidate) => candidate.trip !== firstTrip && candidate.time >= reached.arrival + 5 * 60000 && candidate.time <= reached.arrival + 120 * 60000).slice(0, 30);
      for (const second of connections) {
        for (let destination = second.position + 1; destination < second.trip.stops.length; destination++) {
          if (second.trip.stops[destination].dropoff !== '1' && second.trip.stops[destination].station === to) {
            addJourney([leg(firstTrip, first.position, end), leg(second.trip, second.position, destination)]);
            break;
          }
        }
      }
    }
  }
  return Array.from(journeys.values()).sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival) || a.changes - b.changes).slice(0, 10);
}

function listenOnAvailablePort(port, attemptsLeft = 20) {
  const host = process.env.HOST || '127.0.0.1';
  const onError = (error) => {
    server.removeListener('listening', onListening);
    if (error.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.warn('Port ' + port + ' ist belegt; versuche Port ' + (port + 1) + '.');
      listenOnAvailablePort(port + 1, attemptsLeft - 1);
      return;
    }
    throw error;
  };
  const onListening = () => {
    server.removeListener('error', onError);
    const address = server.address();
    console.log(host === '0.0.0.0' ? 'Live-Abfahrten hört auf allen Netzwerkadressen, Port ' + address.port + '.' : 'Live-Abfahrten läuft auf http://127.0.0.1:' + address.port);
    console.log('Zum Beenden Strg+C drücken.');
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, host);
}

listenOnAvailablePort(preferredPort);
