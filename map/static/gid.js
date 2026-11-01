const params = new Proxy(new URLSearchParams(window.location.search), {
    get: (searchParams, prop) => searchParams.get(prop),
});

let StationConfiguration = [];

// Отрезки ниток на экране: по ним находим нитку под курсором (правая кнопка)
let gidSegments = [];

// Смещение берём у самой выбранной даты, а не у текущего момента
// Шкала всегда по Москве (UTC+3): полночь МСК выбранного дня
const MSK_OFFSET_MS = 3 * 3600 * 1000;
function calcGraphStart(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) - MSK_OFFSET_MS);
}
// Если дата не указана в адресе (/gid без ?date=), берём сегодняшнюю.
// Раньше new Date(null) давал 1970 год, и поезда уходили далеко за правый край сетки.
const todayLocalStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10); // сегодня по МСК
var GraphStartTime = calcGraphStart(params.date || todayLocalStr);
var startUnix = GraphStartTime.getTime();
const GraphHourLength = 24; // Всего 24 часа в сутках
let GraphHourStart = 0; // шкала начинается с 0 по МСК
let GraphHeight = 1000;
const GridColor = "#A9A9A9"
    
const oneHourLength = 1500;
const leftMargin = 250;
const topMargin = 50;

let renderedTrains = [];
let renderedNGDP = [];
let AllowedMapsTable = [];
let twolink
const plusUnix = 10800 * 1000
var settingsStage = ""

var settingsTable = [];

const RenderTemplate = (elem) => {
    const two = new Two().appendTo(elem);
    twolink = two
    
    // Делаем ширину графика на 1 час больше (25 часов), чтобы после 24 была пустая заглушка
    let graphWidth = oneHourLength * (GraphHourLength + 1);

    console.log(elem)
    GraphHeight = Math.max(1000, elem.getBoundingClientRect().height);

    var topBorderLine = two.makeLine(leftMargin, topMargin, graphWidth, topMargin)
    topBorderLine.linewidth = 3;
    topBorderLine.className = "gridline";
    topBorderLine.stroke = GridColor

    const StationList = document.getElementById("stations")
    StationList.childNodes.forEach(element => element.remove());
    StationList.style.top = elem.getBoundingClientRect().top + "px"
    StationList.style.width = leftMargin + "px";
    StationList.style.height = GraphHeight + "px";

    two.width = graphWidth;
    two.height = GraphHeight + topMargin;

    for (let st = 0; st < StationConfiguration.length; st++) {
        if (StationConfiguration[st].IsTurnover)
            continue

        let stationPos = topMargin + StationConfiguration[st].Pos;

        // Строго ограничиваем горизонтальную линию отметкой 24 часа (GraphHourLength), 
        // чтобы в пустой зоне-заглушке справа линии не рисоковались
        let maxLineWidth = oneHourLength * GraphHourLength;
        let grid = two.makeLine(0, stationPos, maxLineWidth, stationPos)
        grid.linewidth = 2;
        grid.className = "gridline";
        grid.stroke = GridColor
        
        const newItem = document.createElement('div');
        newItem.style.cssText = "position: absolute;top: " + (stationPos - 29) + "px;width:" + (leftMargin) + "px;"
        newItem.className = "StationText"
        newItem.style.borderBottomColor = GridColor
        newItem.textContent = StationConfiguration[st].Name;
        StationList.appendChild(newItem);
    }

    // Рисуем часы от 0 до 24 включительно (итого 25 колонок: от 0 до 24)
    for (let i = 0; i <= GraphHourLength; i++) {
        let hourPos = leftMargin + oneHourLength * i;

        let timeHour = two.makeText(GraphHourStart + i, hourPos, 25);
        timeHour.size = 48;
        timeHour.weight = 800;

        let grid = two.makeLine(hourPos, topMargin, hourPos, 1000)
        grid.linewidth = 5;
        grid.className = "gridline";
        grid.stroke = GridColor

        // Для самой последней отметки (24 часа) внутренние минуты не нужны — оставляем чистую линию часа как границу суток
        if (i === GraphHourLength) continue;

        for (let j_min = 0; j_min < 60 / 5; j_min++) {
            let fiveMinutePos = hourPos + (oneHourLength / (60 / 5) * j_min)

            if (j_min != 0) { 
                let fiveMinuteHour = two.makeText(5 * j_min, fiveMinutePos, 25);
                fiveMinuteHour.size = 32;
                fiveMinuteHour.weight = 500;

                let grid = two.makeLine(fiveMinutePos, topMargin, fiveMinutePos, 1000)
                grid.linewidth = 2;
                grid.className = "gridline";
                grid.stroke = GridColor
            }

            for (let st = 0; st < StationConfiguration.length; st++) {
                if (StationConfiguration[st].IsTurnover)
                    continue

                let stationPos = topMargin + StationConfiguration[st].Pos;

                let grid = two.makeLine(fiveMinutePos, stationPos, fiveMinutePos + hourPos + (oneHourLength / (60 / 5) * (j_min + 1)), stationPos)
                grid.linewidth = 2;
                grid.className = "gridline";
                grid.stroke = GridColor

                for (let j = 1; j < 60 / 3; j++) {
                    // Мелкие засечки (j не кратно 4) не рисуем, остаются только крупные
                    if (j % 4 != 0)
                        continue;

                    let coef = (oneHourLength / (60 / 5)) / 20; 
                    let height = 15;

                    let grid = two.makeLine(fiveMinutePos + (j * coef), stationPos - (st != 0 ? height : 0), fiveMinutePos + (j * coef), stationPos + (st != StationConfiguration.length - 1 ? height : 0))
                    grid.linewidth = 2;
                    grid.className = "gridline";
                    grid.stroke = GridColor
                }
            }
        }
    }

    two.update();

    return two;
}

let template
const RenderTrains = (two, trains) => {
    
    let objects = [];

    const oneMinuteLength = oneHourLength / 60;
    const oneSecondLength = oneMinuteLength / 60;
    const fiveMinuteLength = oneMinuteLength * 5;
        
    const findedStationByNumber = (i, id) => (
        StationConfiguration.find(val => {
            if (!trains[i + id])
                return false;

            if (trains[i + id].StationID == val.ID)
                return true
        })
    )

    let trainLines = []
    let routeNumbers = []
    let color = "green"
    let routeNumberKey; 
    let renderStar;
    let trainLinePosY;
    for (let i = 0; i < trains.length; i++) {
        renderStar = false;
        let findedStation = findedStationByNumber(i, 0);
        if (!findedStation)
            continue;
        
        let nextst = trains[i+1]
        let prevst = trains[i-1]
        let findedEndStation = findedStationByNumber(i, 1);
        let findedPrevStation = findedStationByNumber(i, -1);

        let curNodeLength = ((trains[i].Time.getTime() - startUnix) / 1000) * oneSecondLength
        let nextNodeLength;

        if (trains.length >= 2 && (i == 0 || i == trains.length - 1)) {
            renderStar = {
                Y: findedStation.Pos,
                X:  curNodeLength,
                Pos: false
            }

            if (i == 0){
                if (findedStation) {
                    renderStar.Pos = findedEndStation.Pos - findedStation.Pos <= 0 ? true : false
                }
            } else if (i == trains.length - 1){
                if (findedPrevStation && findedStation) {
                    renderStar.Pos = findedPrevStation.Pos - findedStation.Pos == 0 ? true : false
                }
            }
        }

        if (renderStar) {
            let turnoverStar = two.makeLine(leftMargin + renderStar.X - (10 * (renderStar.Pos ? 0 : 1)), topMargin + renderStar.Y - (10 * (renderStar.Pos ? 1 : 0)), leftMargin + renderStar.X + (10 * (renderStar.Pos ? 0 : 1)), topMargin + renderStar.Y + (10 * (renderStar.Pos ? 1 : 0)))
            turnoverStar.linewidth = 2;

            objects.push(turnoverStar)
        }


        if (!prevst || !nextst) {
            trainLines.push({
                Y: findedStation.Pos,
                X: curNodeLength,
                EndX: curNodeLength,
                EndY: findedStation.TurnoverPos
            })

            if (!nextst)
                break
        }

        nextNodeLength = ((nextst.Time.getTime() - startUnix) / 1000) * oneSecondLength
        if (!findedEndStation)
            findedEndStation = findedStation
        
        if (!findedStation.IsTurnover && !findedEndStation.IsTurnover ) {
            if (findedStation.ID < findedEndStation.ID){
                color = "green"
            } else if (findedStation.ID > findedEndStation.ID){
                color = "red"
            }
        }
        
        if (trains[i].ARS == 0){
            if (color == "red"){
                color = "orange"
            } else if (color == "green") {
                color = "rgb(150,75,0)"
            }
        }

        trainLinePosY = findedEndStation.Pos;
        if ((findedStationByNumber(i, 2) && findedStationByNumber(i, 2).IsTurnover) || (findedPrevStation && findedPrevStation.IsTurnover) || findedStation.IsTurnover)
            color =	"black"

            
        let rnMargin = 0
        if (findedStation.IsTurnover) {
            let centerLineX = curNodeLength + ((nextNodeLength) - curNodeLength) / 2

            let textMargin = -10
            rnMargin = -1
            if (findedStation.Pos > StationConfiguration[StationConfiguration.length - 1].Pos / 2) {
                textMargin = 15
                rnMargin = 1
            }

            let crossNumber = routeNumbers.find(route => {
                return Math.abs(route.X - centerLineX) < 300;
            })

            if (routeNumberKey != findedStation.ID + "_" + trains[i].Route) {
                routeNumbers.push({
                    Y: findedStation.Pos + rnMargin + textMargin,
                    X: centerLineX,
                    Route: trains[i].Route,
                })
            }

            routeNumberKey = findedStation.ID + "_" + trains[i].Route
        }

        if (nextNodeLength - curNodeLength < 5 && color != "black") {
            let skipStationStar1 = two.makeLine(leftMargin + nextNodeLength - 10, topMargin + findedEndStation.Pos - 10, leftMargin + nextNodeLength + 10, topMargin + findedEndStation.Pos + 10)
            skipStationStar1.linewidth = 2;
            skipStationStar1.stroke = "red"

            let skipStationStar2 = two.makeLine(leftMargin + nextNodeLength + 10, topMargin + findedEndStation.Pos - 10, leftMargin + nextNodeLength - 10, topMargin + findedEndStation.Pos + 10)
            skipStationStar2.linewidth = 2;
            skipStationStar2.stroke = "red"

            objects.push(skipStationStar1)
            objects.push(skipStationStar2)
        }
    
        trainLines.push({
            Y: findedStation.Pos + rnMargin,
            X: curNodeLength,
            EndX: nextNodeLength,
            EndY: findedEndStation.Pos + rnMargin,
            Color: color
        })
    }

    for (let i = 0; i < routeNumbers.length; i++) {
        let timeHour = two.makeText(routeNumbers[i].Route, leftMargin + routeNumbers[i].X, topMargin + routeNumbers[i].Y);
        timeHour.size = 24;

        objects.push(timeHour)
    }

    for (let i = 0; i < trainLines.length; i++) {
        var trainLine = two.makeLine(leftMargin + trainLines[i].X, topMargin + trainLines[i].Y, leftMargin + trainLines[i].EndX, topMargin + trainLines[i].EndY)
        trainLine.linewidth = 2;

        gidSegments.push({
            threadId: trains.ThreadID,
            x1: leftMargin + trainLines[i].X,
            y1: topMargin + trainLines[i].Y,
            x2: leftMargin + trainLines[i].EndX,
            y2: topMargin + trainLines[i].EndY,
            line: trainLine
        });
        trainLine.stroke = trainLines[i].Color
        
        objects.push(trainLine)
    }

    two.update();

    return objects;
}

const RenderNGDP = (two, trains) => {
    let objects = []

    const oneMinuteLength = oneHourLength / 60;
    const oneSecondLength = oneMinuteLength / 60;
    const fiveMinuteLength = oneMinuteLength * 5;
        
    const findedStationByNumber = (i, id) => {
        return StationConfiguration.find(val => {
            if (!trains[i + id])
                return false;

            if (trains[i + id].StationID == val.ID)
                return true
        });
    }

    let ngdpLines = []
    for (let i = 0; i < trains.length; i++) {
        renderStar = false;
        let findedStation = findedStationByNumber(i, 0);
        if (!findedStation)
            continue;
        
        let nextst = trains[i+1]
        let prevst = trains[i-1]
        let findedEndStation = findedStationByNumber(i, 1);
        let findedPrevStation = findedStationByNumber(i, -1);

        let curNodeLength = ((trains[i].Time.getTime() - startUnix) / 1000) * oneSecondLength
        let nextNodeLength;
        if (!prevst || !nextst) {
            ngdpLines.push({
                Y: findedStation.Pos,
                X: curNodeLength,
                EndX: curNodeLength,
                EndY: findedStation.TurnoverPos
            })

            if (!nextst)
                break
        }

        nextNodeLength = ((nextst.Time.getTime() - startUnix) / 1000) * oneSecondLength
        if (!findedEndStation)
            findedEndStation = findedStation
        
        let color
        if (!findedStation.IsTurnover && !findedEndStation.IsTurnover ) {
            if (findedStation.ID < findedEndStation.ID){
                color = "green"
            } else if (findedStation.ID > findedEndStation.ID){
                color = "red"
            }
        }

        ngdpLines.push({
            Y: findedStation.Pos,
            X: curNodeLength,
            EndX: nextNodeLength,
            EndY: findedEndStation.Pos,
            Color: color
        })
    }

    for (let i = 0; i < ngdpLines.length; i++) {
        var trainLine = two.makeLine(leftMargin + ngdpLines[i].X, topMargin + ngdpLines[i].Y, leftMargin + ngdpLines[i].EndX, topMargin + ngdpLines[i].EndY)
        trainLine.linewidth = 3;
        trainLine.stroke = GridColor
        
        objects.push(trainLine)
    }

    two.update();

    return objects;
}


const renderLoader = () => {
    const loader = document.getElementById("loader")
    loader.style.display = "flex"
    loader.childNodes.forEach(element => element.remove());

    const header = document.createElement("h1");        
    header.textContent = "ЗАГРУЗКА, ПОДОЖДИТЕ..."; 

    loader.append(header);
}

var dataField = document.getElementById('graphDate');
dataField.oninput = function() {
    renderLoader();

    socket.emit('ChangeDate', dataField.value);
    
    GraphStartTime = calcGraphStart(dataField.value);
    GraphHourStart = 0;
    startUnix = GraphStartTime.getTime();
    
    history.pushState(null, null, 'gid?date='+dataField.value);

    renderedTrains.forEach(render => twolink.remove(render));
    renderedNGDP.forEach(render => twolink.remove(render));

    twolink.update();
};

var mapField = document.getElementById('map');
mapField.oninput = function() {
    renderLoader();

    setTimeout(() => socket.emit('ChangeMap', mapField.value), 200);
};

var serverField = document.getElementById('server');
serverField.oninput = function() {
    socket.emit('ChangeServer', serverField.value)
};

const socket = io()
let counter = 0
socket.on('connect', () => {
    console.log("Подключение установлено")
    socket.emit('Start', { counter })

    const loader = document.getElementById("loader")
    loader.style.display = "flex"
    loader.childNodes.forEach(element => element.remove());

    const header = document.createElement("h1");        
    header.textContent = "ВЫБЕРИТЕ КАРТУ"; 

    loader.append(header);
})

socket.on('DateSet', DateFromURL => {
    var dataField = document.getElementById('graphDate');
    dataField.value = DateFromURL
})

socket.on('MapTableSend', MapTable => {
    StationConfiguration = MapTable
    template = RenderTemplate(document.getElementById("container"))
})

// ===== НГДП на сетке: серые линии (плановый график) =====
let ngdpRoutes = [];
// Отрезки НГДП на экране: по ним находим маршрут при нажатии правой кнопки
let ngdpSegments = [];

const renderNGDPLines = () => {
    renderedNGDP.forEach(line => { try { twolink.remove(line); } catch (e) {} });
    renderedNGDP = [];
    ngdpSegments = [];
    if (!template || !ngdpRoutes.length) {
        if (typeof twolink !== 'undefined' && twolink) twolink.update();
        return;
    }

    const oneMinuteLength = oneHourLength / 60;
    const oneSecondLength = oneMinuteLength / 60;
    const posOf = id => {
        const st = StationConfiguration.find(v => String(v.ID) === String(id));
        return st ? st.Pos : null;
    };
    const stationOf = id => StationConfiguration.find(v => String(v.ID) === String(id)) || null;

    const GREEN = '#1f9d55';
    const RED = '#c0392b';
    const GREY = '#5a5a5a';

    ngdpRoutes.forEach(route => {
        // Только станции, которые есть на карте (с позицией)
        const kept = route.stations.filter(st => posOf(st.StationID) !== null);
        if (kept.length < 2) return;

        // Точки: прибытие и отправление каждой станции (стоянка = горизонталь, перегон = наклонная)
        const pts = [];
        kept.forEach(st => {
            const y = posOf(st.StationID);
            // Оборот рисуем отдельной линией над станцией: её длина = время стоянки в тупике
            const cfg = stationOf(st.StationID);
            const ly = (cfg && cfg.IsTurnover) ? y - 12 : y;
            pts.push({ x: st.Arr * oneSecondLength, y: ly });
            pts.push({ x: st.Dep * oneSecondLength, y: ly });
        });

        // Направление каждого перегона: вперёд (ID растёт) — зелёный, назад — красный.
        // После оборота (смены направления) цвет меняется, стоянка окрашивается по приходящему перегону
        // ID оборотов бывают вида 802-Т-3: сравниваем по числовой части, при равенстве — по позиции
        const dirColor = (fromSt, toSt) => {
            const fn = parseInt(String(fromSt.StationID), 10);
            const tn = parseInt(String(toSt.StationID), 10);
            if (!isNaN(fn) && !isNaN(tn) && fn !== tn) return tn > fn ? GREEN : RED;
            const fp = posOf(fromSt.StationID), tp = posOf(toSt.StationID);
            if (fp === null || tp === null || fp === tp) return GREY;
            return tp > fp ? GREEN : RED;
        };

        const moveColor = [];
        for (let k = 0; k + 1 < kept.length; k++) {
            moveColor.push(dirColor(kept[k], kept[k + 1]));
        }

        for (let i = 0; i + 1 < pts.length; i++) {
            const idx = Math.floor(i / 2);
            let color;
            if (i % 2 === 0) {
                // стоянка на станции idx: цвет по направлению отправления (как на обороте в тупике)
                color = idx < moveColor.length ? moveColor[idx] : moveColor[idx - 1];
            } else {
                // перегон от станции idx к idx+1
                color = moveColor[idx];
            }

            const a = pts[i], b = pts[i + 1];
            const line = twolink.makeLine(leftMargin + a.x, topMargin + a.y, leftMargin + b.x, topMargin + b.y);
            line.linewidth = 4;
            line.cap = 'round';
            line.stroke = color;
            renderedNGDP.push(line);

            ngdpSegments.push({
                route: route.Route,
                x1: leftMargin + a.x, y1: topMargin + a.y,
                x2: leftMargin + b.x, y2: topMargin + b.y
            });
        }

        // Номер маршрута пишем только на обороте (там, где направление меняется)
        for (let k = 1; k < kept.length - 1; k++) {
            if (moveColor[k - 1] === moveColor[k]) continue;
            const p0 = pts[2 * k];
            const label = twolink.makeText(String(route.Route), leftMargin + p0.x + 4, topMargin + p0.y - 10);
            label.size = 16;
            label.weight = 700;
            label.fill = moveColor[k];
            label.alignment = 'left';
            renderedNGDP.push(label);
        }
    });

    twolink.update();
};

socket.on('NGDPRoutes', routes => {
    ngdpRoutes = routes || [];
    renderNGDPLines();
});


socket.on('AllowedMaps', MapsTable => {
	AllowedMapsTable = MapsTable
    for (let i = 0; i < MapsTable.length; i++) {
        const optionElement = document.createElement('option');
        optionElement.textContent = MapsTable[i].MapRussian;
        optionElement.value = MapsTable[i].Map;
        var mapElement = document.getElementById("map");
        if (mapElement) {
            mapElement.appendChild(optionElement)
        }
    }
})

socket.on('AllowedNGDP', NGDPTable => {
    for (let i = 0; i < NGDPTable.length; i++) {
        const optionElement = document.createElement('option');
        optionElement.textContent = NGDPTable[i].Name;
        optionElement.value = NGDPTable[i].ID;
        var graphElement = document.getElementById("graph");
        if (graphElement) {
            graphElement.appendChild(optionElement)
        }
    }
})

socket.on('AllowedServers', ServersTable => {
    for (let i = 0; i < ServersTable.length; i++) {
        const optionElement = document.createElement('option');
        optionElement.textContent = ServersTable[i].Name;
        optionElement.value = ServersTable[i].ID;
        var graphElement = document.getElementById("server");
        if (graphElement) {
            graphElement.appendChild(optionElement)
        }
    }
})

socket.on('GIDTable', tbl => {
    if ((!tbl || !tbl.length) && StationConfiguration.length == 0)
        return;
    if (!template) return; // сетка ещё не построена, подождём MapTableSend

    const loader = document.getElementById("loader")
    loader.childNodes.forEach(element => element.remove());
    loader.style = "display:none"
    
    console.log("get gidtable. len = "+tbl.length)
    let GIDTable = [];
    for (let i = 0; i < tbl.length; i++) {
        if (!GIDTable[tbl[i].ThreadID])
            GIDTable[tbl[i].ThreadID] = [];

        GIDTable[tbl[i].ThreadID].push({
            Time: new Date(tbl[i].Time * 1000),
            StationID: tbl[i].StationID,
            Route: tbl[i].Route,
            ARS: tbl[i].ARS
        })
    }

    renderedTrains.forEach(render => twolink.remove(render));
    
    gidSegments = [];
    GIDTable.forEach((elem, threadId) => {
        elem.ThreadID = threadId;
        renderedTrains.push(RenderTrains(template, elem));
    });
})

function openSettings() {}

// ===== Редактор станций карты =====
let editorMap = null;

socket.on('GetMapSettingsAnswer', rows => {
    renderStationEditor(rows.slice().sort((a, b) => b.Pos - a.Pos));
});

function makeStationRow(st) {
    const row = document.createElement('div');
    row.className = 'stRow';
    row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid #ddd;';

    const pos = document.createElement('input');
    pos.type = 'number'; pos.step = 'any'; pos.value = st.Pos; pos.title = 'Позиция';
    pos.style.width = '70px';

    const id = document.createElement('input');
    id.type = 'text'; id.value = st.ID; id.title = 'ID станции'; id.style.width = '60px';

    const name = document.createElement('input');
    name.type = 'text'; name.value = st.Name; name.title = 'Название'; name.style.width = '170px';

    const nextId = document.createElement('input');
    nextId.type = 'text'; nextId.value = st.NextID || ''; nextId.title = 'Следующая станция (ID)'; nextId.style.width = '60px';

    const turnover = document.createElement('input');
    turnover.type = 'checkbox'; turnover.checked = !!st.IsTurnover; turnover.title = 'Оборот';

    const switches = document.createElement('input');
    switches.type = 'checkbox'; switches.checked = !!st.Switches; switches.title = 'Стрелки';

    const del = document.createElement('button');
    del.textContent = 'Удалить';
    del.addEventListener('click', () => row.remove());

    const lbl = (text, el) => { const l = document.createElement('label'); l.style.fontSize = '12px'; l.append(text, el); return l; };

    row.append(
        lbl('Поз ', pos),
        lbl('ID ', id),
        lbl('Название ', name),
        lbl('След. ', nextId),
        lbl('Оборот ', turnover),
        lbl('Стрелки ', switches),
        del
    );
    return row;
}

function renderStationEditor(rows) {
    const box = document.getElementById("buttonsSettings");
    box.innerHTML = "";

    const list = document.createElement('div');
    list.id = 'stationList';
    rows.forEach(st => list.append(makeStationRow(st)));
    box.append(list);

    const buttons = document.createElement('div');
    buttons.style.marginTop = '8px';

    const addBtn = document.createElement('button');
    addBtn.textContent = 'Добавить станцию';
    addBtn.addEventListener('click', () => {
        const positions = Array.from(list.querySelectorAll('.stRow input[title="Позиция"]')).map(i => Number(i.value)).filter(n => !isNaN(n));
        const maxPos = positions.length ? Math.max(...positions) : 0;
        list.prepend(makeStationRow({ ID: '', Pos: maxPos + 10, Name: '', NextID: '', IsTurnover: false, Switches: false }));
    });

    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Сохранить станции';
    saveBtn.addEventListener('click', () => {
        const stations = [];
        list.querySelectorAll('.stRow').forEach(row => {
            const get = t => row.querySelector('input[title="' + t + '"]');
            stations.push({
                ID: get('ID станции').value.trim(),
                Pos: Number(get('Позиция').value),
                Name: get('Название').value.trim(),
                NextID: get('Следующая станция (ID)').value.trim(),
                IsTurnover: get('Оборот').checked ? 1 : 0,
                Switches: get('Стрелки').checked ? 1 : 0
            });
        });
        if (!editorMap) { alert('Сначала нажмите «Редактировать карту» и выберите карту'); return; }
        socket.emit('SaveMapStations', { map: editorMap, stations: stations });
    });

    buttons.append(addBtn, ' ', saveBtn);
    box.append(buttons);
}

socket.on('MapSettingsSaved', msg => {
    alert('Станции сохранены. ' + msg + '\nЧтобы увидеть изменения на карте, нажмите «Обновить нитки».');
    if (editorMap) socket.emit('GetMapSettings', editorMap);
});

function buttonPressSettings(element) {
    if (element.id != "mapSettings") return;

    const divElement = document.getElementById("buttonsSettings");
    divElement.innerHTML = "";

    const selectMapElement = document.createElement('select');
    divElement.appendChild(selectMapElement);

    for (let i = 0; i < AllowedMapsTable.length; i++) {
        const optionElement = document.createElement('option');
        optionElement.textContent = AllowedMapsTable[i].MapRussian;
        optionElement.value = AllowedMapsTable[i].Map;
        selectMapElement.appendChild(optionElement);
    }

    const editMap = document.createElement('button');
    editMap.textContent = "Редактировать карту";
    editMap.addEventListener('click', () => {
        editorMap = selectMapElement.value;
        socket.emit('GetMapSettings', editorMap);
    });
    divElement.appendChild(editMap);
}

// ===== НГДП: редактор в настройках =====
let ngdpEditMap = null;
let ngdpEditId = 0;
let ngdpStationList = [];

function openNGDPBox() {
    const box = document.getElementById('ngdpBox');
    if (!box) return;
    box.innerHTML = '';

    const mapSel = document.createElement('select');
    AllowedMapsTable.forEach(m => {
        const o = document.createElement('option');
        o.value = m.Map;
        o.textContent = m.MapRussian;
        mapSel.append(o);
    });
    if (mapField && mapField.value) mapSel.value = mapField.value;

    const loadMap = () => {
        ngdpEditMap = mapSel.value;
        socket.emit('GetStationList', ngdpEditMap);
        socket.emit('GetNGDPList', ngdpEditMap);
    };
    mapSel.addEventListener('change', loadMap);

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Обновить список';
    loadBtn.addEventListener('click', loadMap);

    box.append(mapSel, ' ', loadBtn);
    loadMap();

    const list = document.createElement('div');
    list.id = 'ngdpList';
    list.style.marginTop = '8px';
    box.append(list);

    const form = document.createElement('div');
    form.id = 'ngdpForm';
    box.append(form);
}

// В расписании НГДП только станции, где можно остановиться (оборотные скрыты)
socket.on('StationList', rows => { ngdpStationList = rows || []; });

socket.on('NGDPList', data => {
    if (data.map !== ngdpEditMap) return;
    const box = document.getElementById('ngdpList');
    if (!box) return;
    box.innerHTML = '';

    (data.list || []).forEach(n => {
        const row = document.createElement('div');
        row.className = 'srvRow';

        const name = document.createElement('div');
        name.className = 'srvName';
        name.textContent = n.Name;
        name.style.width = '220px';

        const when = document.createElement('div');
        when.style.flex = '1';

        const edit = document.createElement('button');
        edit.textContent = 'Изменить';
        edit.addEventListener('click', () => { ngdpEditId = n.ID; socket.emit('GetNGDPSchedule', n.ID); });

        const del = document.createElement('button');
        del.textContent = 'Удалить';
        del.addEventListener('click', () => {
            if (confirm('Удалить НГДП «' + n.Name + '»?')) socket.emit('DeleteNGDP', n.ID);
        });

        row.append(name, when, edit, del);
        box.append(row);
    });

    const add = document.createElement('button');
    add.textContent = 'Создать НГДП';
    add.style.marginTop = '8px';
    add.addEventListener('click', () => { ngdpEditId = 0; renderNGDPForm({ id: 0, name: '', routes: [] }); });
    box.append(add);
});

socket.on('NGDPSchedule', sch => {
    if (sch.id !== ngdpEditId) return;
    renderNGDPForm(sch);
});

socket.on('NGDPSaved', res => {
    const form = document.getElementById('ngdpForm');
    if (form) form.innerHTML = '';
    ngdpEditId = 0;
    if (ngdpEditMap) socket.emit('GetNGDPList', ngdpEditMap);
    if (res && res.deleted) return;
    alert('НГДП сохранён. Теперь выберите его в списке «НГДП» на карте.');
});

function makeStationBlock(st) {
    const block = document.createElement('div');
    block.className = 'stBlock';
    block.style.cssText = 'display:flex;gap:6px;align-items:center;margin:3px 0;';

    const sel = document.createElement('select');
    ngdpStationList.forEach(s => {
        const o = document.createElement('option');
        o.value = s.ID;
        o.textContent = s.Name + ' (' + s.ID + ')';
        sel.append(o);
    });
    sel.value = st.StationID || '';

    const arr = document.createElement('input');
    arr.type = 'time'; arr.step = '1'; arr.value = st.Arr || ''; arr.title = 'Прибытие';

    const dep = document.createElement('input');
    dep.type = 'time'; dep.step = '1'; dep.value = st.Dep || ''; dep.title = 'Отправление';

    const del = document.createElement('button');
    del.textContent = 'x';
    del.addEventListener('click', () => block.remove());

    block._collect = () => ({ StationID: sel.value, Arr: arr.value, Dep: dep.value });
    block.append(sel, ' приб ', arr, ' отпр ', dep, del);
    return block;
}

function makeRouteBlock(r) {
    const block = document.createElement('div');
    block.className = 'routeBlock';
    block.style.cssText = 'border:1px solid #999;padding:6px;margin:6px 0;background:#f6f6f6;';

    const routeNum = document.createElement('input');
    routeNum.type = 'number'; routeNum.value = r.Route; routeNum.style.width = '70px'; routeNum.title = 'Номер маршрута';

    const reverseBox = document.createElement('input');
    reverseBox.type = 'checkbox'; reverseBox.checked = !!r.Reverse; reverseBox.title = 'Обратная дорога';
    const reverseLbl = document.createElement('label');
    reverseLbl.style.marginLeft = '8px';
    reverseLbl.append(reverseBox, ' Обратная дорога');

    const byStation = {};
    (r.stations || []).forEach(st => { byStation[String(st.StationID)] = st; });

    const table = document.createElement('div');
    table.style.cssText = 'margin-top:6px;max-height:260px;overflow-y:auto;background:#fff;padding:4px;';

    const head = document.createElement('div');
    head.style.cssText = 'font-size:12px;color:#555;display:flex;gap:6px;padding-bottom:4px;';
    head.innerHTML = '<span style="width:240px">Станция</span><span style="width:110px">Прибытие</span><span style="width:110px">Отправление</span>';
    table.append(head);

    const rows = [];
    ngdpStationList.forEach(s => {
        const saved = byStation[String(s.ID)] || {};
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;align-items:center;padding:2px 0;border-bottom:1px solid #eee;';

        const label = document.createElement('span');
        label.style.width = '240px';
        label.textContent = s.Name + ' (' + s.ID + ')' + (s.IsTurnover ? ' — оборот' : '');
        if (s.IsTurnover) label.style.fontWeight = 'bold';

        const arr = document.createElement('input');
        arr.type = 'time'; arr.step = '1'; arr.value = saved.Arr || ''; arr.style.width = '110px';

        const dep = document.createElement('input');
        dep.type = 'time'; dep.step = '1'; dep.value = saved.Dep || ''; dep.style.width = '110px';

        row.append(label, arr, dep);
        table.append(row);
        rows.push({ id: s.ID, arr, dep });
    });

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#555;margin-top:4px;';
    hint.textContent = 'Пусто — маршрут на станцию не идёт. Одно время — проезд без остановки (второе копируется). Оборот — время заезда в тупик и выезда из него.';

    const delRoute = document.createElement('button');
    delRoute.textContent = 'Удалить маршрут';
    delRoute.addEventListener('click', () => block.remove());

    block._collect = () => ({
        Route: routeNum.value,
        Reverse: reverseBox.checked,
        stations: rows
            .filter(x => x.arr.value || x.dep.value)
            .map(x => ({ StationID: x.id, Arr: x.arr.value, Dep: x.dep.value }))
    });

    block.append('Маршрут ', routeNum, ' ', reverseLbl, ' ', delRoute, table, hint);
    return block;
}

function renderNGDPForm(sch) {
    const form = document.getElementById('ngdpForm');
    if (!form) return;
    form.innerHTML = '';

    const title = document.createElement('h4');
    title.textContent = sch.id ? 'Редактирование НГДП' : 'Новый НГДП';
    form.append(title);

    const name = document.createElement('input');
    name.type = 'text'; name.value = sch.name || ''; name.placeholder = 'Название НГДП'; name.style.width = '260px';

    const top = document.createElement('div');
    top.append('Название: ', name);
    form.append(top);

    const routesBox = document.createElement('div');
    routesBox.id = 'ngdpRoutes';
    (sch.routes || []).forEach(r => routesBox.append(makeRouteBlock(r)));
    form.append(routesBox);

    const addRoute = document.createElement('button');
    addRoute.textContent = 'Добавить маршрут';
    addRoute.addEventListener('click', () => routesBox.append(makeRouteBlock({ Route: '', stations: [] })));

    const save = document.createElement('button');
    save.textContent = 'Сохранить НГДП';
    save.style.marginLeft = '6px';
    save.addEventListener('click', () => {
        const routes = Array.from(routesBox.querySelectorAll('.routeBlock')).map(b => b._collect());
        const mapKey = ngdpEditMap || (mapField && mapField.value) || '';
        if (!mapKey) { alert('Выберите карту в настройках НГДП'); return; }
        socket.emit('SaveNGDP', {
            id: sch.id || 0,
            map: mapKey,
            name: name.value,
            routes: routes
        });
    });

    const cancel = document.createElement('button');
    cancel.textContent = 'Отмена';
    cancel.style.marginLeft = '6px';
    cancel.addEventListener('click', () => { form.innerHTML = ''; ngdpEditId = 0; });

    form.append(addRoute, save, cancel);
}
