-- Starts the Discord -> OBS mute bridge whenever OBS starts. The bridge stops by
-- itself when OBS closes. Made by:  node bridge.js --make-obs-script
-- (run that again if you move the bridge folder or reinstall Node.js)
obs = obslua

local NODE = "C:\\nvm4w\\nodejs\\node.exe"
local BRIDGE = "C:\\Users\\Daniel\\Desktop\\Code\\OBSdiscMute\\bridge.js"
local FOLDER = "C:\\Users\\Daniel\\Desktop\\Code\\OBSdiscMute"

local on_windows = package.config:sub(1, 1) == "\\"

local function exists(file)
  local handle = io.open(file, "r")
  if handle then handle:close() end
  return handle ~= nil
end

-- Windows: ask the shell to open node.exe with its window hidden (SW_HIDE), so no
-- console window pops up over a game. Text is passed as UTF-16 so any folder name works.
local function start_on_windows(node)
  local ffi = require("ffi")
  ffi.cdef[[
    int MultiByteToWideChar(unsigned int codepage, unsigned long flags, const char* text, int bytes, wchar_t* out, int chars);
    void* ShellExecuteW(void* window, const wchar_t* verb, const wchar_t* file, const wchar_t* arguments, const wchar_t* folder, int show);
  ]]
  local kernel32 = ffi.load("kernel32")
  local function wide(text)
    local chars = kernel32.MultiByteToWideChar(65001, 0, text, -1, nil, 0)
    local buffer = ffi.new("wchar_t[?]", chars)
    kernel32.MultiByteToWideChar(65001, 0, text, -1, buffer, chars)
    return buffer
  end
  local SW_HIDE = 0
  local arguments = '"' .. BRIDGE .. '" --with-obs'
  local result = ffi.load("shell32").ShellExecuteW(nil, wide("open"), wide(node), wide(arguments), wide(FOLDER), SW_HIDE)
  local code = tonumber(ffi.cast("intptr_t", result))
  if code <= 32 then
    error("Windows could not start " .. node .. " (ShellExecute code " .. code .. ")")
  end
end

-- macOS and Linux: run it in the background through the shell.
local function start_on_unix(node)
  local function quote(text)
    return "'" .. text:gsub("'", "'\\''") .. "'"
  end
  os.execute(quote(node) .. " " .. quote(BRIDGE) .. " --with-obs >/dev/null 2>&1 &")
end

local function start_bridge()
  local node = exists(NODE) and NODE or "node" -- else whatever "node" is on the PATH
  local ok, problem = pcall(on_windows and start_on_windows or start_on_unix, node)
  if ok then
    print("Mute bridge: started. It writes what it does to bridge.log in " .. FOLDER)
  else
    print("Mute bridge: could not be started: " .. tostring(problem))
  end
end

function script_description()
  return "Starts the Discord -> OBS mute bridge when OBS starts. The bridge stops by itself when OBS closes.\n\n"
    .. "What it does is written to bridge.log in " .. FOLDER
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_button(props, "start_bridge", "Start the bridge now", function()
    start_bridge()
    return false
  end)
  return props
end

function script_load(settings)
  start_bridge()
end
