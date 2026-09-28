# DriveLoad for Safari

The `extension/` directory is a Safari-compatible WebExtension source. Building
an installable Safari app requires full Xcode and an Apple signing identity.

1. Install Xcode from the Mac App Store and open it once.
2. Run `xcrun safari-web-extension-converter extension --project-location safari-build`.
3. Open the generated Xcode project.
4. Select your Apple development team under Signing & Capabilities.
5. Build and run the macOS container app, then enable DriveLoad in Safari's
   Extensions settings.

The extension downloads public, non-DRM media that the user is authorized to
save. Website access controls and DRM are not bypassed.
