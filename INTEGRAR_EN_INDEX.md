# Cómo integrar habits-survey.js en index.js

## 3 cambios únicos:

### 1. Al inicio, después de los otros require:
```js
const { initHabitsSurvey } = require('./habits-survey');
```

### 2. Después de crear el bot (busca la línea donde creas el bot):
```js
// Ejemplo: const bot = new TelegramBot(token, {polling: true});
// DESPUÉS de esa línea agregar:
initHabitsSurvey(bot, process.env.TELEGRAM_CHAT_ID);
```

### 3. Si ya tienes un cron a las 10am que hace algo manual, 
   puedes dejarlo o eliminarlo — initHabitsSurvey ya registra el suyo.

## Eso es todo. El módulo se encarga de:
- Cron 10am hora Chile → envía encuesta si no se completó hoy
- Botones inline de Telegram para responder
- Guardar en Supabase tabla daily_habits
- Responder con resumen al terminar
