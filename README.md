# ГИД — График Исполненного Движения для Metrostroi Subway Simulator

Система для визуального отображения движения поездов по линии для игрового режима Metrostroi Subway Simulator (Garry's Mod).

<img width="1266" height="492" alt="image" src="https://github.com/user-attachments/assets/8ec16644-14f4-47e4-ad3c-9d3ec4ed7ad3" />

Игровая часть используемая на сервере в Garry's Mod: https://github.com/DmitryAtrashkow/gid_connector

## Установка

1. Клонируйте репозиторий:
```bash
git clone https://github.com/Doogls/metrostroi_gid.git
cd metrostroi_gid
```

2. Установите зависимости:
```bash
npm install
```

3. Создайте файл конфигурации:
```bash
cp env.example .env
```

4. Отредактируйте `.env` и заполните необходимые параметры:
   - `DATABASE_FILE` - путь к файлу базы данных SQLite
   - `SALT` - секретный ключ для подписи JWT токенов (используйте случайную строку)
   - `TRUSTED_USERS` - список SteamID64 (через запятую), у которых есть повышенные права.
   - `MAIN_PAGE` - URL вашего сайта (необходим для Steam аутентификации)
   - `STEAM_KEY` - ключ Steam API (получить можно на https://steamcommunity.com/dev/apikey)
   - `TRUSTED_MODE` - режим ограниченного доступа (0 — всем, 1 — только доверенным пользователям из `TRUSTED_USERS`)

### TRUSTED_MODE

- `TRUSTED_MODE` — режим работы:
   - `0` (по умолчанию) — ГИД доступен всем, но изменение настроек разрешено только доверенным пользователям из `TRUSTED_USERS`.
   - `1` — ГИД доступен только пользователям, перечисленным в `TRUSTED_USERS`.

## Запуск

```bash
node server.js
```

Сервер будет доступен по адресу `http://localhost:3000`

## Структура проекта

- `server.js` - основной серверный файл
- `settings.js` - обработчик конфигурационного файл
- `env.example` - пример конфигурационного файла
- `client/` - клиентские файлы (HTML, JS, статические ресурсы)
- `gid.db` - база данных SQLite

## Лицензия

Этот проект лицензирован под Apache License 2.0. Подробности см. в файле [LICENSE](LICENSE).

## Авторы

Давыденок Алексей Алексеевич (https://github.com/Doogls) — Визуальная часть, рендер и основа серверной части

Атрашков Дмитрий Олегович (https://github.com/DmitryAtrashkow) — Обработчик данных с игрового сервера и базы данных, структура базы данных
