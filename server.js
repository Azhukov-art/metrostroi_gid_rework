import { createServer } from "http";
import { readFileSync, readdirSync } from "fs";
import { WebSocketServer } from "ws";
import Database from "better-sqlite3";
import { Server as ServerIO } from "socket.io";
import url from "url";
import express from "express";
import SteamAuth from "node-steam-openid";
import jwt from "jsonwebtoken";
import { randomInt } from "crypto";
import settings from "./settings.js";

const db = new Database(settings.databaseFile);

// Серверы ГИД: название + ключ, который вводится в игре (metrostroi_gid_key)
db.exec(`CREATE TABLE IF NOT EXISTS gid_servers (
	ServerID INTEGER PRIMARY KEY AUTOINCREMENT,
	Name TEXT NOT NULL,
	GidKey TEXT NOT NULL UNIQUE
)`);

// Пинги игрового сервера (раз в минуту): по ним понимаем, был ли сервер онлайн
db.exec(`CREATE TABLE IF NOT EXISTS gid_heartbeats (
	ServerID INTEGER NOT NULL,
	Time INTEGER NOT NULL,
	PRIMARY KEY (ServerID, Time)
)`);

// События смены карты, которые присылает игровой сервер (даже без поездов и ГИД-триггеров)
db.exec(`CREATE TABLE IF NOT EXISTS gid_map_events (
	EventID INTEGER PRIMARY KEY AUTOINCREMENT,
	ServerID INTEGER NOT NULL,
	Map TEXT NOT NULL,
	Time INTEGER NOT NULL
)`);

// Добавляем новые колонки в уже существующую базу (если их ещё нет)
const addColumnIfMissing = (table, column, def) => {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all();
	if (!cols.some(c => c.name === column)) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
	}
}
addColumnIfMissing("gid_threads", "Deleted", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("gid_points", "Nick", "TEXT");
addColumnIfMissing("gid_ngdp_list", "Recurrence", "TEXT NOT NULL DEFAULT 'daily'");
addColumnIfMissing("gid_ngdp_list", "DayOfMonth", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("gid_ngdp_threads", "Reverse", "INTEGER NOT NULL DEFAULT 0");

const generateGidKey = () => {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
	let key = "";
	for (let i = 0; i < 32; i++) key += chars[randomInt(chars.length)];
	return key;
}

const getStaticFile = url => {
	let content = "";
	const files = readdirSync("./client/static");

	files.forEach(file => {
		url.forEach(urlFile => {
			if (file == urlFile && content == "")
				content = readFileSync("./client/static/" + file, { encoding: "utf-8" }).toString();
		});
	});

	return content;
}

const getCookies = (req) => {
	var cookie = req.headers.cookie;
	return cookie.split(';').reduce((res, item) => {
		const data = item.trim().split('=');
		return { ...res, [data[0]]: data[1] };
	}, {});
}

const renderMain = (req, res) => {
	const template = readFileSync("./client/main.html", { encoding: "utf-8" });
	if (settings.hasGIDAccess())
		return res.send(template);

	if (!req.headers.cookie)
		return res.redirect("/auth");

	const cookie = getCookies(req);
	if (!cookie || !cookie.auth_token)
		return res.redirect("/auth");

	let verified = jwt.verify(cookie.auth_token, settings.salt);
	try {
		if (!verified) return res.redirect('/auth');
	} catch (e) {
		return res.redirect('/auth');
	}

	const steamid = verified && verified.steamid ? verified.steamid : null;
	if (!settings.hasGIDAccess(steamid)) {
		// В режиме 1 доступ только для доверенных пользователей
		return res.status(403).send('Access denied');
	}

	res.send(template);
}

var app = express();

app.get("/", renderMain);
app.get("/gid", renderMain);
app.use("/static", express.static("./client/static"));

const steam = new SteamAuth({
	realm: settings.mainPage,
	returnUrl: settings.mainPage + "/auth/authenticate",
	apiKey: settings.steamKey,
});

app.get("/auth", async (_, res) => {
	const redirectUrl = await steam.getRedirectUrl();
	return res.redirect(redirectUrl);
});

app.get("/auth/authenticate", async (req, res) => {
	try {
		const user = await steam.authenticate(req);
		const steamID = user.steamid;

		const token = jwt.sign({ "steamid": steamID }, settings.salt)

		let options = {
			maxAge: 1000 * 60 * 60 * 24 * 15, // срок жизни cookie — 15 дней
			httpOnly: true, // cookie доступна только веб-серверу
		}

		res.cookie("auth_token", token, options)
	} catch (error) {
		console.error(error);
	}

	return res.redirect("/");
});

// Возвращает статус аутентификации текущего клиента
app.get('/auth/status', (req, res) => {
	try {
		if (!req.headers.cookie) return res.json({ authenticated: false, trusted: false, hasAccess: false });

		const cookies = req.headers.cookie.split(';').reduce((acc, item) => {
			const data = item.trim().split('=');
			return { ...acc, [data[0]]: data[1] };
		}, {});

		if (!cookies.auth_token) return res.json({ authenticated: false, trusted: false, hasAccess: false });

		const verified = jwt.verify(cookies.auth_token, settings.salt);
		const steamid = verified && verified.steamid ? verified.steamid : null;
		const trusted = settings.isUserTrusted(steamid);
		const hasAccess = settings.hasGIDAccess(steamid);

		return res.json({ authenticated: true, trusted: trusted, hasAccess: hasAccess });
	} catch (e) {
		return res.json({ authenticated: false, trusted: false, hasAccess: false });
	}
});

// Простой выход - сбрасываем cookie с токеном
app.get('/auth/logout', (req, res) => {
	res.clearCookie('auth_token');
	return res.redirect('/');
});

const server = createServer(app);
const io = new ServerIO(server);
server.listen(3000)

const dateFormat = (date, fstr, utc) => {
	utc = utc ? 'getUTC' : 'get';
	return fstr.replace(/%[YmdHMS]/g, m => {
		switch (m) {
			case '%Y': return date[utc + 'FullYear']();
			case '%m': m = 1 + date[utc + 'Month'](); break;
			case '%d': m = date[utc + 'Date'](); break;
			case '%H': m = date[utc + 'Hours'](); break;
			case '%M': m = date[utc + 'Minutes'](); break;
			case '%S': m = date[utc + 'Seconds'](); break;
			default: return m.slice(1);
		}

		return ('0' + m).slice(-2);
	});
}

const logInfo = text => console.log(dateFormat(new Date(), "[%d-%m-%Y %H:%M:%S]", false), text);

// Всё время в ГИДе — по Москве (UTC+3), как на игровом сервере
const MSK_OFFSET_SEC = 3 * 3600;
const mskMidnightUnix = (dateStr) => {
	const [y, m, d] = String(dateStr).split('-').map(Number);
	return Math.floor(Date.UTC(y, m - 1, d) / 1000) - MSK_OFFSET_SEC;
}
const mskTodayStr = () => new Date(Date.now() + MSK_OFFSET_SEC * 1000).toISOString().slice(0, 10);

let DeltaTime = new Date().getTime();

// Публичный список серверов (без ключей)
const getServersList = () => {
	return db.prepare("SELECT ServerID AS ID, Name FROM gid_servers ORDER BY ServerID").all();
}

// Полный список с ключами (только для доверенных в настройках)
const getServersFull = () => {
	return db.prepare("SELECT ServerID AS ID, Name, GidKey AS Key FROM gid_servers ORDER BY ServerID").all();
}

const defaultServerId = () => {
	const list = getServersList();
	return list.length ? list[0].ID : 0;
}

const getSteamIdFromSocket = (socket) => {
	const cookie = socket.handshake.headers.cookie;
	if (!cookie) return null;
	const cookies = cookie.split(';').reduce((res, item) => {
		const data = item.trim().split('=');
		return { ...res, [data[0]]: data[1] };
	}, {});
	if (!cookies.auth_token) return null;
	try {
		const verified = jwt.verify(cookies.auth_token, settings.salt);
		return verified && verified.steamid ? verified.steamid : null;
	} catch (e) {
		return null;
	}
}

const isTrustedSocket = (socket) => {
	const steamid = getSteamIdFromSocket(socket);
	return !!steamid && settings.isUserTrusted(steamid);
}

// Сегменты карт сервера за день.
// Карта идёт до смены на другую карту. Если пингов от сервера нет — это «Неизвестно».
// Тишина на карте (поезда не ехали) при работающем сервере — это не «Неизвестно».
// Время НГДП хранится как секунды от полуночи (МСК): 15:30:30 = 55830
const parseHMS = (str) => {
	const p = String(str || "").trim().split(':').map(Number);
	if (p.length < 2 || p.length > 3 || p.some(n => isNaN(n))) return null;
	const [h, m, sec = 0] = p;
	if (h > 23 || m > 59 || sec > 59) return null;
	return h * 3600 + m * 60 + sec;
}

const sodToHMS = (sod) => {
	const v = ((sod % 86400) + 86400) % 86400;
	const h = String(Math.floor(v / 3600)).padStart(2, "0");
	const m = String(Math.floor((v % 3600) / 60)).padStart(2, "0");
	const s = String(v % 60).padStart(2, "0");
	return h + ":" + m + ":" + s;
}

// Маршруты НГДП: станции с временем прибытия и отправления (в секундах от полуночи)
const buildNGDPRoutes = (ngdpId) => {
	const threads = db.prepare("SELECT ThreadID, Route, TrainNumber, Reverse FROM gid_ngdp_threads WHERE NGDPID = ? ORDER BY ThreadID").all(ngdpId);
	return threads.map(t => {
		const pts = db.prepare("SELECT StationID, Time, Type FROM gid_ngdp_points WHERE ThreadID = ? ORDER BY ID").all(t.ThreadID);
		const stations = [];
		pts.forEach(p => {
			const last = stations[stations.length - 1];
			if (p.Type === 'Dep' && last && last.StationID === p.StationID && last.Dep === null) {
				last.Dep = p.Time;
			} else {
				stations.push({ StationID: p.StationID, Arr: p.Time, Dep: p.Type === 'Dep' ? p.Time : null });
			}
		});
		stations.forEach(st => { if (st.Dep === null) st.Dep = st.Arr; });
		return { Route: t.Route, TrainNumber: t.TrainNumber, Reverse: !!t.Reverse, stations };
	});
}

const infoByMap = (mapKey) => {
	return db.prepare("SELECT gid_maps.Map AS Map, gid_maps.MapRussian AS MapRussian, (SELECT COUNT(*) FROM gid_stations WHERE gid_stations.MapID = gid_maps.MapID) AS StationsCount FROM gid_maps WHERE gid_maps.Map = ?").get(mapKey);
}

const getDaySegments = (serverId, dateStr) => {
	const dayStart = mskMidnightUnix(dateStr);
	const dayEnd = dayStart + 86400;
	const nowUnix = Math.floor(Date.now() / 1000);
	const isToday = nowUnix >= dayStart && nowUnix < dayEnd;
	const windowEnd = isToday ? nowUnix : dayEnd;
	const BUCKET = 60;      // пинг пишется раз в минуту
	const ALIVE_GAP = 120;  // пауза между пингами дольше 2 минут = сервер офлайн

	const fmt = (unix) => {
		const mins = Math.floor((unix - dayStart) / 60);
		const hh = String(Math.floor(mins / 60)).padStart(2, "0");
		const mm = String(mins % 60).padStart(2, "0");
		return hh + ":" + mm;
	}

	// 1. Нитки дня (удалённые не учитываем)
	const rows = db.prepare(`SELECT gid_threads.ThreadID AS ThreadID, gid_threads.Map AS Map,
			MIN(gid_points.Time) AS First, MAX(gid_points.Time) AS Last
		FROM gid_threads INNER JOIN gid_points ON gid_points.ThreadID = gid_threads.ThreadID
		WHERE gid_threads.ServerID = ? AND gid_threads.Deleted = 0 AND gid_points.Time >= ? AND gid_points.Time < ?
		GROUP BY gid_threads.ThreadID ORDER BY First`).all(serverId, dayStart, dayEnd);

	// 2. Смены карт (даже без поездов)
	const events = db.prepare("SELECT Map, Time FROM gid_map_events WHERE ServerID = ? AND Time >= ? AND Time < ? ORDER BY Time")
		.all(serverId, dayStart, dayEnd);

	const items = [
		...rows.map(r => ({ Map: r.Map, First: r.First, Last: r.Last })),
		...events.map(e => ({ Map: e.Map, First: e.Time, Last: e.Time }))
	].sort((a, b) => a.First - b.First);

	// 3. Отрезки одной карты (тишина внутри карты отрезок не разрывает)
	const runs = [];
	for (const it of items) {
		const last = runs[runs.length - 1];
		if (last && last.Map === it.Map) {
			last.Last = Math.max(last.Last, it.Last);
		} else {
			runs.push({ Map: it.Map, Start: it.First, Last: it.Last });
		}
	}

	// 4. Офлайн-периоды по пингам
	const hbTotal = db.prepare("SELECT COUNT(*) AS n FROM gid_heartbeats WHERE ServerID = ?").get(serverId).n;
	const unknowns = [];
	if (hbTotal > 0) {
		const beats = db.prepare("SELECT Time FROM gid_heartbeats WHERE ServerID = ? AND Time >= ? AND Time < ? ORDER BY Time")
			.all(serverId, dayStart, windowEnd).map(r => r.Time);

		const alive = [];
		beats.forEach(t => {
			const cur = alive[alive.length - 1];
			if (cur && t - cur.to <= ALIVE_GAP) {
				cur.to = t + BUCKET;
			} else {
				alive.push({ from: t, to: t + BUCKET });
			}
		});

		let cursor = dayStart;
		alive.forEach(a => {
			if (a.from > cursor) unknowns.push({ start: cursor, end: a.from });
			cursor = Math.max(cursor, a.to);
		});
		if (windowEnd - cursor > ALIVE_GAP) {
			// Сегодня: сервер молчит до сих пор — конец открыт. Прошлый день: до конца суток.
			unknowns.push({ start: cursor, end: isToday ? null : dayEnd });
		}
	}

	// Первая карта дня начинается с 00:00, если до неё не было офлайна
	if (runs.length && !(unknowns.length && unknowns[0].start <= dayStart)) {
		runs[0].Start = dayStart;
	}

	// 5. Таймлайн: карты и офлайн вперемешку по времени
	const timeline = [
		...runs.map(r => ({ kind: "map", start: r.Start, last: r.Last, Map: r.Map })),
		...unknowns.map(u => ({ kind: "unk", start: u.start, end: u.end }))
	].sort((a, b) => a.start - b.start);

	// 6. Конец карты = начало следующего события (смена карты или офлайн). Если их нет — хх:хх
	const result = [];
	timeline.forEach((ev, i) => {
		if (ev.kind === "unk") {
			result.push({
				Unknown: true, Name: "Неизвестно", HasConfig: false,
				StartText: fmt(ev.start),
				EndText: ev.end === null ? "хх:хх" : fmt(ev.end)
			});
			return;
		}

		const next = timeline.slice(i + 1).find(x => x.start > ev.start);
		const endText = next ? fmt(Math.max(next.start, ev.last)) : "хх:хх";

		const info = infoByMap(ev.Map);
		result.push({
			Map: ev.Map,
			Name: info && info.MapRussian ? info.MapRussian : ev.Map,
			HasConfig: !!(info && info.StationsCount > 0),
			StartText: fmt(ev.start),
			EndText: endText
		});
	});

	// Данных за день совсем нет
	if (!result.length) {
		result.push({ Unknown: true, Name: "Неизвестно", HasConfig: false, StartText: "", EndText: "" });
	}

	// 7. Одна карточка на карту (или «Неизвестно»), внутри — все промежутки
	const groups = [];
	const byKey = {};
	result.forEach(seg => {
		const key = seg.Unknown ? "__unknown__" : seg.Map;
		if (!byKey[key]) {
			byKey[key] = { Map: seg.Map || "", Name: seg.Name, HasConfig: !!seg.HasConfig, Unknown: !!seg.Unknown, Times: [] };
			groups.push(byKey[key]);
		}
		if (seg.StartText) byKey[key].Times.push({ StartText: seg.StartText, EndText: seg.EndText });
	});

	// Порядок: карты с конфигом, затем без конфига, «Неизвестно» в самом конце
	const rank = g => (g.Unknown ? 2 : (g.HasConfig ? 0 : 1));
	groups.sort((a, b) => rank(a) - rank(b));

	return groups;
}
let clientSettings = {};

io.on("connection", socket => {
	const defaultMap = db.prepare("SELECT Map FROM gid_maps ORDER BY MapID LIMIT 1").get();
	clientSettings[socket.id] = {
		"selectedmap": defaultMap ? defaultMap.Map : "gm_flatgrass",
		"selectedserver": defaultServerId(),
		"showDeleted": false,
		"changedDate": mskMidnightUnix(mskTodayStr())
	};

	let selectedngdp = 0;
	let _, args = url.parse(socket.handshake.headers.referer || "", true).query;

	logInfo("Web client connected from IP: " + socket.handshake.address)

	// Проверка доступа при подключении сокета (учитывает режим TRUSTED_MODE)
	let connectingSteamId = null;
	try {
		if (socket.handshake.headers.cookie) {
			const cookies = socket.handshake.headers.cookie.split(';').reduce((res, item) => {
				const data = item.trim().split('=');
				return { ...res, [data[0]]: data[1] };
			}, {});
			if (cookies.auth_token) {
				const verified = jwt.verify(cookies.auth_token, settings.salt);
				connectingSteamId = verified && verified.steamid ? verified.steamid : null;
			}
		}
	} catch (e) {
		console.log('Socket auth verify error:', e.message);
	}

	if (!settings.hasGIDAccess(connectingSteamId)) {
		console.log('Access denied for socket connection from', socket.handshake.address);

		socket.emit('Error', 'Access denied');
		socket.disconnect(true);
		delete clientSettings[socket.id];

		return;
	}

	async function selectThreadsFromDB(date) {
		const dateplusoneday = date + 86400

		const rows =
			db.prepare("SELECT * FROM gid_points INNER JOIN gid_threads ON gid_threads.ThreadID = gid_points.ThreadID WHERE Time > ? AND Time < ? AND Map = ? AND gid_threads.ServerID = ? AND gid_threads.Deleted = ?")
				.all(date, dateplusoneday, clientSettings[socket.id]["selectedmap"], clientSettings[socket.id]["selectedserver"], clientSettings[socket.id]["showDeleted"] ? 1 : 0);

		let returnTable = [];
		rows.forEach(row => {
			returnTable.push({
				ThreadID: row.ThreadID,
				StationID: row.StationID,
				SteamID: row.SteamID,
				Route: row.Route,
				Time: row.Time,
				Type: row.Type,
				ARS: row.ARS
			})
		});

		return returnTable;
	}

	const tableInterval = setInterval(async () => {
		const selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"]);
		socket.emit('GIDTable', selected);
	}, 2000)

	// получаем данные от клиента
	socket.on('Start', async _ => {
		let selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"])

		socket.emit('GIDTable', selected);

		// Дата
		let datefromurl = args.date;
		if (datefromurl) {
			clientSettings[socket.id]["changedDate"] = mskMidnightUnix(datefromurl)

			logInfo("Set Date for client to " + clientSettings[socket.id]["changedDate"]);
			socket.emit('DateSet', datefromurl);
		} else {
			socket.emit('DateSet', mskTodayStr());
		}

		// Серверы
		socket.emit('AllowedServers', getServersList());

		// Карта
		const rowsMaps = db.prepare("SELECT * FROM gid_maps").all();
		socket.emit('AllowedMaps', rowsMaps);

		const rowsNGDP = db.prepare("SELECT * FROM gid_ngdp_list INNER JOIN gid_maps ON gid_maps.MapID = gid_ngdp_list.MapID WHERE Map = ?").all(clientSettings[socket.id]["selectedmap"]);

		socket.emit('AllowedNGDP', rowsNGDP);
	})

	socket.on('ChangeDate', data => {
		clientSettings[socket.id]["changedDate"] = mskMidnightUnix(data)
		console.log(data + " changed date to " + clientSettings[socket.id]["changedDate"])
	})

	socket.on('GetServers', () => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на настройки серверов');
		socket.emit('ServersFull', getServersFull());
	})

	socket.on('AddServer', (name) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на настройки серверов');
		const cleanName = String(name || "").trim();
		if (!cleanName) return socket.emit('Error', 'Введите название сервера');
		db.prepare("INSERT INTO gid_servers (Name, GidKey) VALUES (?, ?)").run(cleanName, generateGidKey());
		socket.emit('ServersFull', getServersFull());
		socket.emit('AllowedServers', getServersList());
	})

	socket.on('DeleteServer', (id) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на настройки серверов');
		db.prepare("DELETE FROM gid_servers WHERE ServerID = ?").run(Number(id));
		socket.emit('ServersFull', getServersFull());
		socket.emit('AllowedServers', getServersList());
	})

	socket.on('GetDaySegments', (data) => {
		// data: { serverId, date } — дата в формате YYYY-MM-DD
		const segments = getDaySegments(Number(data.serverId), data.date);
		socket.emit('DaySegments', segments);
	})

	socket.on('SetShowDeleted', async (flag) => {
		clientSettings[socket.id]["showDeleted"] = !!flag;
		const selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"]);
		socket.emit('GIDTable', selected);
	})

	socket.on('GetThreadInfo', (threadId) => {
		const t = db.prepare("SELECT ThreadID, Route, TrainType, Deleted FROM gid_threads WHERE ThreadID = ?").get(Number(threadId));
		if (!t) return;
		const nick = db.prepare("SELECT Nick FROM gid_points WHERE ThreadID = ? AND Nick IS NOT NULL AND Nick != '' ORDER BY Time DESC LIMIT 1").get(t.ThreadID);
		socket.emit('ThreadInfo', {
			ThreadID: t.ThreadID,
			Route: t.Route,
			TrainType: t.TrainType,
			Nick: nick ? nick.Nick : null,
			Deleted: !!t.Deleted,
			CanEdit: isTrustedSocket(socket)
		});
	})

	// Переименование сервера: ключ (GidKey) не меняется, игра продолжает работать
	socket.on('RenameServer', (data) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на настройки серверов');
		const newName = String((data && data.name) || "").trim();
		if (!newName) return socket.emit('Error', 'Введите название сервера');
		db.prepare("UPDATE gid_servers SET Name = ? WHERE ServerID = ?").run(newName, Number(data.id));
		socket.emit('ServersFull', getServersFull());
		socket.emit('AllowedServers', getServersList());
	})

	socket.on('SetThreadDeleted', async (data) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на удаление ниток');
		db.prepare("UPDATE gid_threads SET Deleted = ? WHERE ThreadID = ?").run(data.deleted ? 1 : 0, Number(data.threadId));
		const selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"]);
		socket.emit('GIDTable', selected);
	})

	socket.on('ChangeServer', async (data) => {
		clientSettings[socket.id]["selectedserver"] = Number(data)
		console.log("server changed to = " + clientSettings[socket.id]["selectedserver"])

		let selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"])
		socket.emit('GIDTable', selected);
	})

	socket.on('ChangeMap', async (data) => {
		clientSettings[socket.id]["selectedmap"] = data
		console.log("map changed to = " + clientSettings[socket.id]["selectedmap"])

		const rows = db.prepare("SELECT * FROM gid_stations INNER JOIN gid_maps ON gid_maps.MapID = gid_stations.MapID WHERE Map = ?").all(clientSettings[socket.id]["selectedmap"]);
		socket.emit('MapTableSend', rows);

		const rowsNGDP = db.prepare("SELECT * FROM gid_ngdp_list INNER JOIN gid_maps ON gid_maps.MapID = gid_ngdp_list.MapID WHERE Map = ?").all(clientSettings[socket.id]["selectedmap"]);
		socket.emit('AllowedNGDP', rowsNGDP);

		let selected = await selectThreadsFromDB(clientSettings[socket.id]["changedDate"])
		socket.emit('GIDTable', selected);

		DeltaTime = Date.now();
	})

	socket.on('GetMapSettings', async (data) => {
		const rows = db.prepare("SELECT * FROM gid_stations INNER JOIN gid_maps ON gid_maps.MapID = gid_stations.MapID WHERE Map = ?").all(data);
		socket.emit('GetMapSettingsAnswer', rows);
	})

	socket.on('SendNewMapSettings', async (data) => {
		// Проверка авторизации пользователя
		if (!socket.handshake.headers.cookie) {
			console.log("Unauthorized access attempt to map settings from IP: " + socket.handshake.address);
			socket.emit('Error', 'Unauthorized: No authentication token');
			return;
		}

		try {
			const cookies = socket.handshake.headers.cookie.split(';').reduce((res, item) => {
				const data = item.trim().split('=');
				return { ...res, [data[0]]: data[1] };
			}, {});

			if (!cookies.auth_token) {
				console.log("Unauthorized access attempt to map settings from IP: " + socket.handshake.address);
				socket.emit('Error', 'Unauthorized: No authentication token');
				return;
			}

			const verified = jwt.verify(cookies.auth_token, settings.salt);
			const isTrusted = settings.isUserTrusted(verified.steamid);

			if (!isTrusted) {
				console.log("Access denied to map settings for SteamID: " + verified.steamid + " from IP: " + socket.handshake.address);
				socket.emit('Error', 'Access denied: User not in trusted list');
				return;
			}

			console.log("User " + verified.steamid + " authorized to change map settings");

			// Пользователь авторизован, выполняем изменения
			var newsettings = JSON.parse(data);
			newsettings.forEach(function(station) {
				const row = db.prepare("DELETE FROM gid_stations WHERE MapID = ? AND ID = ?")
				row.run(station[4], station[0]);
				const row2 = db.prepare('INSERT INTO gid_stations (MapID, ID, Name, Pos, IsTurnover, Switches, NextID) VALUES (?, ?, ?, ?, ?, ?, ?);')
				row2.run(station[4], station[0], station[2], station[1], station[3], station[5], station[6]);
			});

			socket.emit('MapSettingsSaved', 'Settings saved successfully');

		} catch (error) {
			console.error("Error in SendNewMapSettings:", error);
			socket.emit('Error', 'Server error: ' + error.message);
		}
	})

	// Сохранение станций карты целиком: добавленные и удалённые станции применяются сразу
	socket.on('SaveMapStations', (data) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на настройку карт');

		const mapRow = db.prepare("SELECT MapID FROM gid_maps WHERE Map = ?").get(String((data && data.map) || ""));
		if (!mapRow) return socket.emit('Error', 'Карта не найдена в базе');

		const stations = Array.isArray(data.stations) ? data.stations : [];
		const seen = new Set();
		for (const st of stations) {
			const id = String(st.ID || "").trim();
			if (!id) return socket.emit('Error', 'У станции не указан ID');
			if (seen.has(id)) return socket.emit('Error', 'Повторный ID станции: ' + id);
			if (isNaN(Number(st.Pos))) return socket.emit('Error', 'Позиция станции ' + id + ' должна быть числом');
			seen.add(id);
		}

		const replaceAll = db.transaction((rows) => {
			db.prepare("DELETE FROM gid_stations WHERE MapID = ?").run(mapRow.MapID);
			const ins = db.prepare("INSERT INTO gid_stations (MapID, ID, Name, Pos, IsTurnover, Switches, NextID) VALUES (?, ?, ?, ?, ?, ?, ?);");
			rows.forEach(st => {
				ins.run(
					mapRow.MapID,
					String(st.ID).trim(),
					String(st.Name || ""),
					Number(st.Pos),
					st.IsTurnover ? 1 : 0,
					st.Switches ? 1 : 0,
					String(st.NextID || "")
				);
			});
		});
		replaceAll(stations);

		console.log("Станции карты " + data.map + " сохранены: " + stations.length);
		socket.emit('MapSettingsSaved', 'Сохранено станций: ' + stations.length);
	})

	socket.on('GetStationList', (mapKey) => {
		const rows = db.prepare("SELECT gid_stations.ID AS ID, gid_stations.Name AS Name, gid_stations.Pos AS Pos, gid_stations.IsTurnover AS IsTurnover FROM gid_stations INNER JOIN gid_maps ON gid_maps.MapID = gid_stations.MapID WHERE gid_maps.Map = ? ORDER BY gid_stations.Pos DESC")
			.all(String(mapKey || ""));
		socket.emit('StationList', rows);
	})

	socket.on('GetNGDPList', (mapKey) => {
		const list = db.prepare("SELECT gid_ngdp_list.ID AS ID, gid_ngdp_list.Name AS Name, gid_ngdp_list.Recurrence AS Recurrence, gid_ngdp_list.DayOfMonth AS DayOfMonth FROM gid_ngdp_list INNER JOIN gid_maps ON gid_maps.MapID = gid_ngdp_list.MapID WHERE gid_maps.Map = ? AND gid_ngdp_list.Type = 0 ORDER BY gid_ngdp_list.ID")
			.all(String(mapKey || ""));
		socket.emit('NGDPList', { map: mapKey, list });
	})

	socket.on('GetNGDPSchedule', (id) => {
		const head = db.prepare("SELECT ID, Name, Recurrence, DayOfMonth FROM gid_ngdp_list WHERE ID = ?").get(Number(id));
		if (!head) return;
		const routes = buildNGDPRoutes(head.ID).map(r => ({
			Route: r.Route,
			TrainNumber: r.TrainNumber,
			Reverse: r.Reverse,
			stations: r.stations.map(st => ({ StationID: st.StationID, Arr: sodToHMS(st.Arr), Dep: sodToHMS(st.Dep) }))
		}));
		socket.emit('NGDPSchedule', { id: head.ID, name: head.Name, recurrence: head.Recurrence, dayOfMonth: head.DayOfMonth, routes });
	})

	socket.on('SaveNGDP', (data) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на НГДП');

		const mapRow = db.prepare("SELECT MapID FROM gid_maps WHERE Map = ?").get(String((data && data.map) || ""));
		if (!mapRow) return socket.emit('Error', 'Карта не найдена в базе');

		const name = String((data && data.name) || "").trim();
		if (!name) return socket.emit('Error', 'Введите название НГДП');

		const recurrence = data.recurrence === 'monthly' ? 'monthly' : 'daily';
		const dayOfMonth = recurrence === 'monthly' ? Number(data.dayOfMonth) : 0;
		if (recurrence === 'monthly' && !(dayOfMonth >= 1 && dayOfMonth <= 31))
			return socket.emit('Error', 'Укажите день месяца от 1 до 31');

		const prepared = [];
		for (const r of (Array.isArray(data.routes) ? data.routes : [])) {
			const routeNum = Number(r.Route);
			if (!Number.isInteger(routeNum) || routeNum < 0) return socket.emit('Error', 'Номер маршрута должен быть целым числом');
			const pts = [];
			for (const st of (Array.isArray(r.stations) ? r.stations : [])) {
				const sid = String(st.StationID || "").trim();
				let arr = parseHMS(st.Arr);
				let dep = parseHMS(st.Dep);
				// Пустые оба времени — маршрут на эту станцию не идёт
				if (arr === null && dep === null) continue;
				// Одно время — проезд без остановки или остановка без стоянки
				if (arr === null) arr = dep;
				if (dep === null) dep = arr;
				if (!sid) return socket.emit('Error', 'У станции в маршруте ' + routeNum + ' не указан ID');
				if (dep < arr) return socket.emit('Error', 'Отправление раньше прибытия на станции ' + sid);
				pts.push({ sid, arr, dep });
			}
			// Порядок станций на маршруте — по времени прибытия
			pts.sort((a, b) => a.arr - b.arr || a.dep - b.dep);
			prepared.push({ route: routeNum, reverse: r.Reverse ? 1 : 0, pts });
		}

		let id = Number(data.id) || 0;
		const save = db.transaction(() => {
			if (id) {
				db.prepare("UPDATE gid_ngdp_list SET Name = ?, Recurrence = ?, DayOfMonth = ? WHERE ID = ?").run(name, recurrence, dayOfMonth, id);
				db.prepare("DELETE FROM gid_ngdp_points WHERE ThreadID IN (SELECT ThreadID FROM gid_ngdp_threads WHERE NGDPID = ?)").run(id);
				db.prepare("DELETE FROM gid_ngdp_threads WHERE NGDPID = ?").run(id);
			} else {
				const info = db.prepare("INSERT INTO gid_ngdp_list (MapID, Name, Type, Recurrence, DayOfMonth) VALUES (?, ?, 0, ?, ?)")
					.run(mapRow.MapID, name, recurrence, dayOfMonth);
				id = Number(info.lastInsertRowid);
			}
			const insThread = db.prepare("INSERT INTO gid_ngdp_threads (NGDPID, ServerID, Route, TrainNumber, DateStart, Reverse) VALUES (?, 0, ?, 0, 0, ?)");
			const insPoint = db.prepare("INSERT INTO gid_ngdp_points (ThreadID, StationID, Time, Type) VALUES (?, ?, ?, ?)");
			prepared.forEach(r => {
				const tid = Number(insThread.run(id, r.route, r.reverse).lastInsertRowid);
				r.pts.forEach(p => {
					insPoint.run(tid, p.sid, p.arr, 'Arr');
					insPoint.run(tid, p.sid, p.dep, 'Dep');
				});
			});
		});
		save();

		socket.emit('NGDPSaved', { id });
	})

	socket.on('DeleteNGDP', (id) => {
		if (!isTrustedSocket(socket)) return socket.emit('Error', 'Нет прав на НГДП');
		const ngdpId = Number(id);
		const del = db.transaction(() => {
			db.prepare("DELETE FROM gid_ngdp_points WHERE ThreadID IN (SELECT ThreadID FROM gid_ngdp_threads WHERE NGDPID = ?)").run(ngdpId);
			db.prepare("DELETE FROM gid_ngdp_threads WHERE NGDPID = ?").run(ngdpId);
			db.prepare("DELETE FROM gid_ngdp_list WHERE ID = ? AND Type = 0").run(ngdpId);
		});
		del();
		socket.emit('NGDPSaved', { id: ngdpId, deleted: true });
	})

	// НГДП на карте: выбранный в списке НГДП показывается всегда
	socket.on('ChangeNGDP', data => {
		const ngdpId = Number(data && data.ngdpId) || 0;
		const dateStr = String((data && data.date) || "");
		let routes = [];
		if (ngdpId > 0) {
			// НГДП действует, когда его выбрали в списке на карте
			routes = buildNGDPRoutes(ngdpId);
		}
		socket.emit('NGDPRoutes', routes);
	})

	socket.on('RestartGID', data => {
		console.log("RESTARTING GID")
		process.exit()
	})

	socket.on('disconnect', () => {
		clearInterval(tableInterval);
		delete clientSettings[socket.id];
	})
})

const wsServer = new WebSocketServer({ port: 9988 });

wsServer.on('connection', (wsClient, req) => {
	const ip = req.socket.remoteAddress;
	console.log('Новый WebSocket ... ' + ip);
	wsClient.isAlive = true;
	wsClient.on('error', console.error);
	wsClient.on('pong', () => {
		wsClient.isAlive = true;
	});
	wsClient.on('message', function(Message) {
		const text = Message.toString();

		// Игровой скрипт шлёт обычную строку "ping" раз в 5 секунд
		if (text === "ping") {
			wsClient.send("pong");
			return;
		}

		let ParsedMessage;
		try {
			ParsedMessage = JSON.parse(text);
		} catch (e) {
			console.log("Пропущено сообщение, не являющееся JSON: " + text);
			return;
		}

		if (ParsedMessage.Type == "Pass") {
			var PassInfo = ParsedMessage.Message
			PassInfo.Time = Math.floor(new Date().getTime() / 1000)
			PassInfo.Type = "Pass"
			const row = db.prepare('INSERT INTO gid_points (ThreadID, StationID, SteamID, Time, Type, ARS, Nick) VALUES (?, ?, ?, ?, ?, ?, ?);')
			row.run(PassInfo.ThreadID, PassInfo.StInfo, PassInfo.Player, PassInfo.Time, PassInfo.Type, PassInfo.ARS, PassInfo.Nick || null);

		} else if (ParsedMessage.Type == "Start") {
			var StartInfo = ParsedMessage.Message
			const srv = db.prepare("SELECT ServerID FROM gid_servers WHERE GidKey = ?").get(ParsedMessage.Key);
			if (!srv) {
				console.log("Неизвестный ключ ГИД (сервер не добавлен в настройках сайта): " + ParsedMessage.Key);
				return;
			}
			const row = db.prepare('INSERT INTO gid_threads (TrainType, Route, Map, ServerID) VALUES (?, ?, ?, ?);')
			row.run(StartInfo.TrainType, StartInfo.Route, StartInfo.Map, srv.ServerID);
			const Returned = db.prepare("SELECT * FROM gid_threads ORDER BY ThreadID DESC LIMIT 1").all()[0];
			// Четвёртый элемент — название триггера ГИД, его ждёт игровой скрипт
			wsClient.send(JSON.stringify(["ThreadIDChange", Returned.ThreadID, StartInfo.TrainID, StartInfo.GidInfo]))
		} else if (ParsedMessage.Type == "CreateAutoSchedule") {
			var StartInfo = ParsedMessage.Message
			const rowsMap = db.prepare("SELECT * FROM gid_ngdp_list INNER JOIN gid_maps ON gid_maps.MapID = gid_ngdp_list.MapID WHERE Map = ? AND Type = 1").all(StartInfo.Map)[0];
			if (rowsMap) {
				const row = db.prepare('INSERT INTO gid_ngdp_threads (NGDPID, ServerID, Route, TrainNumber, DateStart) VALUES (?, ?, ?, ?, ?);')
				row.run(rowsMap.ID, StartInfo.ServerID, 0, 0, 0);
				const Returned = db.prepare("SELECT * FROM gid_ngdp_threads ORDER BY ThreadID DESC LIMIT 1").all()[0];
				wsClient.send(JSON.stringify(["CreateAutoSchedule", Returned.ThreadID, StartInfo.TrainID]))
			}
		} else if (ParsedMessage.Type == "Ping") {
			const pingSrv = db.prepare("SELECT ServerID FROM gid_servers WHERE GidKey = ?").get(ParsedMessage.Key);
			if (pingSrv) {
				const bucket = Math.floor(Date.now() / 60000) * 60;
				db.prepare("INSERT OR IGNORE INTO gid_heartbeats (ServerID, Time) VALUES (?, ?);").run(pingSrv.ServerID, bucket);
			}
		} else if (ParsedMessage.Type == "MapChange") {
			const mapSrv = db.prepare("SELECT ServerID FROM gid_servers WHERE GidKey = ?").get(ParsedMessage.Key);
			if (!mapSrv) {
				console.log("MapChange: неизвестный ключ ГИД " + ParsedMessage.Key);
				return;
			}
			const mapName = ParsedMessage.Message && ParsedMessage.Message.Map;
			if (!mapName) return;
			db.prepare("INSERT INTO gid_map_events (ServerID, Map, Time) VALUES (?, ?, ?);")
				.run(mapSrv.ServerID, mapName, Math.floor(Date.now() / 1000));
			console.log("Смена карты: " + mapName + " (сервер " + mapSrv.ServerID + ")");
		} else if (ParsedMessage.Type == "AddPointsToNGDP") {
			var PassInfo = ParsedMessage.Message
			const row = db.prepare('INSERT INTO gid_ngdp_points (ThreadID, StationID, Time, Type) VALUES (?, ?, ?, ?);')
			row.run(PassInfo.ThreadID, PassInfo.StationID, PassInfo.Time, PassInfo.Type);
		}
	})

	wsClient.on('close', function() {
		console.log("WebSocket closed")
	})
})