; ─────────────────────────────────────────────────────────────────────────
; TokenTracker.iss — Inno Setup script for the Windows tray app.
;
; Builds a per-user installer (no admin / UAC) that matches the app's own
; design: tokentracker:// protocol and launch-at-startup are registered by
; the app at runtime under HKCU, so the installer only lays down files +
; shortcuts and never touches machine-wide state.
;
; Inputs:
;   ISCC.exe /DMyAppVersion=0.31.1 TokenTracker.iss
;
; Expects the self-contained publish output next to this script at
; ..\publish\ (TokenTracker.exe + the .NET runtime + EmbeddedServer\),
; produced by:
;   dotnet publish ... --self-contained true -o TokenTrackerWin\publish
;   Copy-Item TokenTrackerWin\EmbeddedServer  TokenTrackerWin\publish\EmbeddedServer
; ─────────────────────────────────────────────────────────────────────────

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName "TokenTracker Personal"
#define MyAppPublisher "TokenTracker"
#define MyAppURL "https://github.com/CYRYGBG/TokenTracker"
#define MyAppExeName "TokenTrackerPersonal.exe"

[Setup]
; Stable per-product GUID — keep constant so upgrades replace in place and
; uninstall stays a single Add/Remove Programs entry.
AppId={{86D1E90D-29B2-41C3-982E-B0081A9740B4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
; Per-user install: no admin rights, lands in %LOCALAPPDATA%\Programs.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}
SetupIconFile=..\assets\trayicon.ico
OutputDir=Output
OutputBaseFilename=TokenTracker-Setup-v{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Close a running tray instance (and its EmbeddedServer\node.exe child, which
; holds a file lock) before overwriting its files on upgrade. We drive the
; relaunch ourselves after a silent update, so don't let Restart Manager do it.
CloseApplications=yes
RestartApplications=no

; A language picker appears at setup start (Inno shows it automatically when more
; than one language is listed). English ships with Inno; the Chinese message files
; are bundled here (UTF-8 with BOM) since Inno does not include them.
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "chinesetraditional"; MessagesFile: "ChineseTraditional.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "runtime\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: not WebView2Present
; The whole self-contained publish folder, including EmbeddedServer\ which
; ServerManager resolves from AppContext.BaseDirectory at runtime.
Source: "..\publish\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent

[Code]
function WebView2Present: Boolean;
var
  Version: String;
  Key: String;
begin
  Key := 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  Result := (RegQueryStringValue(HKLM32, Key, 'pv', Version) or
             RegQueryStringValue(HKCU32, Key, 'pv', Version)) and
            (Version <> '') and (Version <> '0.0.0.0');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and not WebView2Present then
  begin
    if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe'),
      '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Unable to start the Microsoft WebView2 Runtime installer.');
    if not WebView2Present then
      RaiseException('Microsoft WebView2 Runtime installation failed. Error: ' + IntToStr(ResultCode));
  end;
end;
