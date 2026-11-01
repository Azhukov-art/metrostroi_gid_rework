import { config } from 'dotenv';
config();

export default {
    // Путь к файлу базы данных SQLite
    databaseFile: process.env.DATABASE_FILE || "gid.db",
    
    // Секретный ключ для подписи JWT токенов
    // ВАЖНО: Используйте длинную случайную строку для безопасности
    // Пример генерации: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    salt: process.env.SALT || "",
    
    // Режим работы системы
    // 0 - ГИД доступен всем, настройки могут менять только trusted пользователи (стандартный режим)
    // 1 - ГИД доступен только trusted пользователям
    trustedMode: parseInt(process.env.TRUSTED_MODE) || 0,
    
    // Массив SteamID64 пользователей, которым разрешен доступ к системе
    // Формат: 17-значное число (например, 76561198123456789)
    trustedUsers: process.env.TRUSTED_USERS
        ? process.env.TRUSTED_USERS.split(',').filter(id => id.trim() !== '').map(id => id.trim()) : [],
    
    // URL вашего сайта (без завершающего слеша)
    // Используется для Steam OpenID аутентификации
    // Примеры: "http://localhost:3000" (для разработки) или "https://yourdomain.com" (для продакшена)
    mainPage: process.env.MAIN_PAGE || "http://localhost:3000",
    
    // Steam Web API Key
    // Получить можно на: https://steamcommunity.com/dev/apikey
    // ВАЖНО: Никогда не публикуйте этот ключ в открытом доступе
    steamKey: process.env.STEAM_KEY || "",
    
    // Функция для проверки, находится ли пользователь в вайтлисте
    // Возвращает true, если пользователь в вайтлисте, иначе false
    isUserTrusted: function(steamId64) {
        // Если вайтлист пуст, разрешаем доступ всем (для разработки)
        if (this.trustedUsers.length === 0)
            return true;
        
        // Проверяем, есть ли пользователь в вайтлисте
        return this.trustedUsers.includes(steamId64);
    },
    
    // Функция для проверки доступа к ГИД в зависимости от режима
    // Возвращает true, если пользователь имеет доступ к просмотру ГИД
    hasGIDAccess: function(steamId64) {
        // Режим 1: доступ только trusted пользователям
        if (this.trustedMode === 1) 
            return this.isUserTrusted(steamId64);

        // Режим 0: доступ для всех
        return true;
    }
}