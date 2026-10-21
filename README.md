# Minecraft Bedrock MCP

Локальный MCP-сервер для строительства в обычном мире **Minecraft Bedrock на Windows**.

Схема: Codex → MCP по stdio → WebSocket на `127.0.0.1:19131` ← Minecraft.
Игра сама подключается командой `/connect`. Зависимости установлены в этой папке;
моды, выделенный игровой сервер и ключ OpenAI API этому проекту не требуются.

## Подготовить игру

1. В общих настройках Minecraft включить **Enable WebSockets**.
2. **Require Encrypted WebSockets** можно оставить включённым. MCP поддерживает
   обмен ключами и шифрование Bedrock, если игра запрашивает этот протокол.
   При выключенном переключателе доступно обычное WebSocket-соединение.
   Сервер принимает соединения только с этого ПК (`127.0.0.1`).
3. Выключить паузу при потере фокуса, чтобы мир продолжал работать при переходе
   в Codex. Во время выполнения команд не оставлять открытым меню паузы.
   Возможность отключения паузы при переключении окон добавлена в
   [Minecraft 26.10](https://www.minecraft.net/en-us/article/minecraft-26-10-bedrock-changelog).
4. Открыть свой мир с разрешёнными читами/командами. Удобнее начать с нового
   творческого мира: включение читов влияет на доступность достижений.
5. После запуска MCP ввести в чат игры:

   ```text
   /connect 127.0.0.1:19131
   ```

Названия переключателей могут отличаться в локализованном интерфейсе.
Начиная с 1.21.60 WebSockets выключены по умолчанию, а обязательное шифрование
включено — это указано в [официальном списке изменений Minecraft](https://www.minecraft.net/en-us/article/minecraft-1-21-60-bedrock-changelog).
[`/connect` — псевдоним `/wsserver`](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/commandsreference/examples/commands/wsserver?view=minecraft-bedrock-stable);
команда требует прав администратора мира и читов.

## Подключить к Codex

В конфигурации Codex используется такая запись (путь заменить при переносе проекта):

```toml
[mcp_servers.minecraft-bedrock]
command = 'C:\Program Files\nodejs\node.exe'
args = ['C:\Users\coolb\GitHub\Minecraft\src\index.js']
startup_timeout_sec = 15
tool_timeout_sec = 120
```

Либо добавить через CLI:

```powershell
codex mcp add minecraft-bedrock -- "C:\Program Files\nodejs\node.exe" "C:\Users\coolb\GitHub\Minecraft\src\index.js"
```

После изменения конфигурации перезапустить MCP через интерфейс приложения или
начать новую сессию Codex. В текущий уже сформированный набор инструментов
этого чата новый MCP автоматически не добавляется.
Настройка stdio и перезапуск описаны в [официальной документации OpenAI](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Затем подключить игру и вызвать `minecraft_status`: должно быть `connected: true`
и `ready: true`. Для шифрованной сессии `encryption` будет `enabled`.

MCP запускается самим клиентом Codex. `npm start` нужен только для ручного
запуска/диагностики; одновременно запускать его и MCP из Codex на одном порту нельзя.
Порт можно изменить переменной `BEDROCK_WS_PORT`; команда из `minecraft_status`
всегда содержит фактический порт. Если он занят другой сессией Codex,
новый экземпляр автоматически выбирает свободный порт. Подключать игру нужно
к команде `/connect` именно из нужной сессии.

Для диагностики доступен самостоятельный MCP-клиент `node scripts/control.mjs`.
Он запускает сервер через официальный SDK, выводит актуальную команду
подключения и принимает по строке JSON с вызовом инструмента, например
`{"name":"minecraft_status","arguments":{}}`. При завершении клиента
запущенный им MCP закрывается.

## Инструменты

| Инструмент | Действие |
| --- | --- |
| `minecraft_status` | Состояние подключения и команда `/connect` |
| `minecraft_command` | Одна произвольная команда Bedrock и ответ игры |
| `minecraft_batch` | До 128 команд последовательно, по умолчанию до первой ошибки |
| `minecraft_set_block` | Один блок, его состояния и измерение |
| `minecraft_fill` | Параллелепипед, в том числе `hollow`/`outline`, до 32 768 блоков |

Например, запрос к Codex: «Построй стеклянный павильон 9×6×9 рядом со мной,
сначала узнай мою позицию». Через `minecraft_command` можно использовать
`querytarget @s` для получения позиции; доступность конкретной команды проверяется ответом игры.

Пример аргументов `minecraft_fill`:

```json
{
  "from": { "x": 10, "y": 64, "z": 10 },
  "to": { "x": 18, "y": 69, "z": 18 },
  "block": "minecraft:glass",
  "mode": "hollow",
  "dimension": "overworld"
}
```

`minecraft_command` и пакет принимают команды с `/` или без него;
`~` и `@s` относятся к подключившемуся игроку. Специализированные инструменты
принимают абсолютные целочисленные координаты и измерение
`overworld`, `nether` или `the_end`.
Состояния передаются объектом, например `{"pillar_axis":"y"}`;
сервер формирует Bedrock-синтаксис `["pillar_axis"="y"]`.

Область строительства должна быть загружена игрой. Углы включаются в объём;
32 768 — ограничение этого инструмента, а не обещание о лимите любой версии игры.
Нужную область большего размера можно построить несколькими командами.
Для `hollow`/`outline` слепое разбиение создаёт лишние внутренние стенки.

Ответы содержат исходное `body`, `statusCode` и UUID запроса.
Отрицательный код и сообщения типа `error` помечаются ошибкой MCP.
При разрыве связи или тайм-ауте результат текущей команды неизвестен:
сервер её автоматически не повторяет. Тайм-аут сам по себе не закрывает
соединение: дальнейшая отправка блокируется до ответа с исходным UUID.
`awaitingLateResponse` показывает такой запрос; если ответ не приходит,
нужно вручную переподключить игру. У пакетов нет транзакции/отката;
успешно выполненные команды сохраняют свои изменения в мире.

## Если не подключается

- Проверить оба переключателя WebSockets, разрешение читов и правильный порт.
- Если соединение установилось, но команды не получают ответа: проверить,
  что мир не находится на паузе и пауза при потере фокуса отключена.
  `minecraft_status` показывает этап инициализации, ошибки протокола и последние
  служебные сведения об ответах без содержимого чата и ключей.
  Если обмен ключами не проходит, для диагностики можно выключить обязательное
  шифрование и переподключиться.
- Проверить, что запущен один экземпляр MCP, а `minecraft_status` показывает `listening: true`.
- Для старой UWP-версии Minecraft Windows иногда требуется разрешение loopback.
  Только если используется пакет `Microsoft.MinecraftUWP`, в PowerShell администратора:

  ```powershell
  CheckNetIsolation.exe LoopbackExempt -a -n="Microsoft.MinecraftUWP_8wekyb3d8bbwe"
  ```

  Это системная настройка, проект сам её не меняет. Нюанс localhost описан
  в [официальной инструкции для Bedrock на Windows](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started?view=minecraft-bedrock-stable).
- При отключении MCP соединение закрывается; после его перезапуска снова выполнить `/connect`.
- Сервер принимает только одного игрового клиента; второй не заменяет активный мир.

## Разработка и проверка

Требуется Node.js 20+.

```powershell
npm ci
npm test
```

Тесты проверяют генерацию команд, WebSocket с имитацией игры и настоящий MCP
stdio handshake через официальный SDK. Они не заменяют проверку в запущенном Minecraft.
В ограниченной среде, запрещающей создание процессов, для модульных тестов можно
использовать `node --test --test-isolation=none test/commands.test.js test/bedrock.test.js`.

Синтаксис команд сверялся с документацией
[`setblock`](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/setblock?view=minecraft-bedrock-stable),
[`fill`](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/fill?view=minecraft-bedrock-stable),
[`execute`](https://learn.microsoft.com/en-us/minecraft/creator/commands/commands/execute?view=minecraft-bedrock-stable).
Внутренние WebSocket-пакеты не имеют стабильной публичной спецификации Microsoft;
формат сверялся с [исходным кодом bedrock-ws](https://github.com/bedrock-ws/bedrockws-deno/blob/main/src/bedrockws/lib/Client.ts).
Обмен ключами P-384 и непрерывный поток AES-256-CFB8 сверялись с
[актуальной реализацией mcpews](https://github.com/mcpews/mcpews/blob/master/src/lib/encrypt.ts)
и [SocketBE](https://github.com/tutinoko2048/SocketBE/blob/main/src/network/packets/encryption-request.ts).
Используется прямой запрос `ws:encrypt` с режимом `cfb8`; ответ обмена ключами
не обязан содержать `statusCode`. Последующие команды и ответы передаются
шифрованными бинарными кадрами. Переходные незашифрованные ответы не расходуют
состояние дешифратора.
Совместимость с установленной версией игры нужно подтвердить живым подключением.
