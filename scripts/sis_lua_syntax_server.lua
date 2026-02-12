-- SiS Lua syntax-check microservice for the VS Code extension.
--
-- This runs inside `sis_headless` and speaks a tiny line-based JSON protocol on
-- stdin/stdout so the extension can ask the *real* SiS Lua parser about syntax
-- errors (including dialect features).
--
-- Each response line is prefixed so the extension can ignore unrelated engine
-- output during startup.

local PROTOCOL = 'sis-lua-syntax-v1'
local PREFIX = '@@SIS_LUA_SYNTAX@@'

local json = dofile('debuggee/dkjson.lua')

local function emit(obj)
  io.stdout:write(PREFIX, json.encode(obj), '\n')
  io.stdout:flush()
end

local function parse_lua_error(err)
  -- Error format from `load` is typically:
  --   "<chunkname>:<line>: <message>"
  -- Chunk names can contain ':' (notably Windows "C:\..."), so this is greedy.
  local chunkname, line_str, message = err:match('^(.*):(%d+):%s*(.*)$')
  if chunkname and line_str and message then
    return {
      chunkname = chunkname,
      line = tonumber(line_str) or 1,
      message = message,
      raw = err,
    }
  end

  return { line = 1, message = err, raw = err }
end

local function check_syntax(text, chunkname)
  local _, err = load(text, chunkname or '=(sis-lua)', 't')
  if not err then
    return {}
  end
  return { parse_lua_error(err) }
end

local function handle_request(req)
  local id = req.id
  local method = req.method
  local params = req.params or {}

  if method == 'ping' then
    return { id = id, ok = true, result = { pong = true } }
  end

  if method == 'shutdown' then
    return { id = id, ok = true, result = {} }, true
  end

  if method == 'check_syntax' then
    local text = params.text
    local chunkname = params.chunkname

    if type(text) ~= 'string' then
      error('check_syntax requires params.text (string)')
    end
    if chunkname ~= nil and type(chunkname) ~= 'string' then
      error('check_syntax params.chunkname must be a string (or nil)')
    end

    return {
      id = id,
      ok = true,
      result = { diagnostics = check_syntax(text, chunkname) },
    }
  end

  return {
    id = id,
    ok = false,
    error = { message = 'unknown method: ' .. tostring(method) },
  }
end

emit({ event = 'ready', protocol = PROTOCOL })

while true do
  local line = headless_read_input()
  if not line then
    break -- stdin EOF
  end

  if line ~= '' then
    local req, _, err = json.decode(line)
    if not req then
      error('failed to decode json request: ' .. tostring(err))
    end
    local resp, should_exit = handle_request(req)
    emit(resp)
    if should_exit then
      break
    end
  end
end
