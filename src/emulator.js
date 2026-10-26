/**
 * Meta's Immersive Web Emulator, for playing the headset version on a desktop: open the game with
 * `?emulate` in the URL and an emulated Quest 3 (with on-screen controls) replaces the browser's
 * WebXR. Loaded only when asked for, so it never ships to a real headset.
 */
export async function installEmulator() {
  const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([import('iwer'), import('@iwer/devui')]);
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  new DevUI(device);
}
