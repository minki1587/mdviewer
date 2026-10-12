; NSIS hooks for the Tauri installer (bundle.windows.nsis.installerHooks).
;
; The app registers itself as a selectable .md handler at runtime
; (src-tauri/src/default_app.rs): OpenWithProgids, Capabilities and
; RegisteredApplications under HKCU. The installer's own file association
; only knows about the ProgID, so remove the rest here on uninstall.
;
; Keep this file ASCII: NSIS reads a BOM-less include in the ANSI code page.

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\RegisteredApplications" "MD Viewer"
  DeleteRegKey HKCU "Software\MD Viewer\Capabilities"
  DeleteRegKey /ifempty HKCU "Software\MD Viewer"

  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "MDViewer.Markdown"
  DeleteRegValue HKCU "Software\Classes\.markdown\OpenWithProgids" "MDViewer.Markdown"
  DeleteRegValue HKCU "Software\Classes\.mdown\OpenWithProgids" "MDViewer.Markdown"
  DeleteRegValue HKCU "Software\Classes\.mkd\OpenWithProgids" "MDViewer.Markdown"

  ; The installer's APP_UNASSOCIATE already deletes this, but the app also
  ; writes it (with FriendlyAppName), so make sure nothing is left behind.
  DeleteRegKey HKCU "Software\Classes\MDViewer.Markdown"

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
