const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");

const profile = process.argv.at(-1);
app.setPath("userData", profile);
app.whenReady().then(async () => {
    const window = new BrowserWindow({
        width: 1280,
        height: 800,
        useContentSize: true,
        webPreferences: { preload: join(profile, "recording.cjs"), sandbox: true, contextIsolation: true },
    });
    globalThis.recordedEdits = [];
    globalThis.recordingArmed = new Promise((resolve) => ipcMain.once("veriq:recording-arm-ack", () => resolve(true)));
    ipcMain.on("veriq:recording-event", (event, edit) => {
        globalThis.recordedEdits.push(edit);
        event.returnValue = null;
    });
    await window.loadFile(join(profile, "inputs.html"));
    window.webContents.send("veriq:recording-arm", { sessionId: "test", generation: 1, navigation: 1, mode: "record" });
});
