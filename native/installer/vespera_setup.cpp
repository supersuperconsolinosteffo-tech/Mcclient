#include "../src/win32_platform.hpp"
#include <commctrl.h>
#include "setup_payload.h"

namespace fs = std::filesystem;
using namespace vespera_win32;

namespace {

constexpr int IDC_DIR_EDIT = 101;
constexpr int IDC_BROWSE_BTN = 102;
constexpr int IDC_CHK_DESKTOP = 103;
constexpr int IDC_CHK_STARTMENU = 104;
constexpr int IDC_CHK_LAUNCH = 105;
constexpr int IDC_PROGRESS = 106;
constexpr int IDC_STATUS_LBL = 107;
constexpr int IDC_INSTALL_BTN = 108;
constexpr int IDC_CANCEL_BTN = 109;

struct InstallerUiHandles {
    HWND hwndMain = nullptr;
    HWND hwndDirEdit = nullptr;
    HWND hwndChkDesktop = nullptr;
    HWND hwndChkStartMenu = nullptr;
    HWND hwndChkLaunch = nullptr;
    HWND hwndProgress = nullptr;
    HWND hwndStatus = nullptr;
    HWND hwndInstallBtn = nullptr;
    HFONT hFontTitle = nullptr;
    HFONT hFontSubtitle = nullptr;
    HFONT hFontBody = nullptr;
    HBRUSH hBrushDark = nullptr;
} g_ui;

void set_status_text(const std::wstring& msg, int progressPct) {
    if (g_ui.hwndStatus) SetWindowTextW(g_ui.hwndStatus, msg.c_str());
    if (g_ui.hwndProgress) SendMessageW(g_ui.hwndProgress, PBM_SETPOS, static_cast<WPARAM>(progressPct), 0);
    UpdateWindow(g_ui.hwndMain);
}

bool execute_installation(
    const fs::path& installDir,
    bool createDesktopShortcut,
    bool createStartMenuShortcut,
    std::wstring& outError
) {
    std::error_code ec;
    set_status_text(L"Creating installation & managed %APPDATA%\\VesperaClient directories...", 12);
    fs::create_directories(installDir, ec);
    fs::create_directories(installDir / "mods", ec);

    fs::path appData = fs::u8path(get_known_folder_utf8(FOLDERID_RoamingAppData, "APPDATA")) / "VesperaClient";
    for (const char* sub : {"instances", "profiles", "runtimes", "mods-pool", "backups", "logs", "vault", "ipc"}) {
        fs::create_directories(appData / sub, ec);
    }

    // 1. Verify SHA-256 of embedded VesperaClient.exe and extract
    set_status_text(L"Verifying SHA-256 & installing VesperaClient.exe (64-bit WebView2)...", 35);
    std::string launcherSha = bcrypt_hash_bytes(kPayloadLauncherExe, kPayloadLauncherExeSize, BCRYPT_SHA256_ALGORITHM);
    if (_stricmp(launcherSha.c_str(), kPayloadLauncherExeSha256) != 0) {
        outError = L"Integrity check failed for embedded VesperaClient.exe payload.";
        return false;
    }
    fs::path launcherExePath = installDir / "VesperaClient.exe";
    if (!write_file_atomic(launcherExePath, kPayloadLauncherExe, kPayloadLauncherExeSize)) {
        outError = L"Unable to write VesperaClient.exe (check folder permissions or close running instance).";
        return false;
    }

    // 2. Verify SHA-256 & install VesperaUninstall.exe
    set_status_text(L"Installing VesperaUninstall.exe & application icon...", 58);
    std::string uninstSha = bcrypt_hash_bytes(kPayloadUninstallExe, kPayloadUninstallExeSize, BCRYPT_SHA256_ALGORITHM);
    if (_stricmp(uninstSha.c_str(), kPayloadUninstallExeSha256) != 0) {
        outError = L"Integrity check failed for embedded VesperaUninstall.exe payload.";
        return false;
    }
    fs::path uninstallExePath = installDir / "VesperaUninstall.exe";
    if (!write_file_atomic(uninstallExePath, kPayloadUninstallExe, kPayloadUninstallExeSize)) {
        outError = L"Unable to write VesperaUninstall.exe.";
        return false;
    }

    // 3. Install vespera.ico, bundled Fabric mod JAR, and LICENSE.txt
    fs::path iconPath = installDir / "vespera.ico";
    write_file_atomic(iconPath, kPayloadIconIco, kPayloadIconIcoSize);

    set_status_text(L"Provisioning verified Vespera Client Fabric 1.21.4 Mod JAR...", 75);
    write_file_atomic(installDir / "mods" / "vespera-client-1.2.1+mc1.21.4.jar", kPayloadModJar, kPayloadModJarSize);
    write_file_atomic(appData / "mods-pool" / "vespera-client-1.2.1+mc1.21.4.jar", kPayloadModJar, kPayloadModJarSize);
    write_text_atomic(installDir / "LICENSE.txt", kPayloadLicenseText);

    // 4. Register in Windows Apps & Features / Add or Remove Programs (HKCU — zero UAC prompt required)
    set_status_text(L"Registering application in Windows Apps & Features...", 88);
    HKEY hKey = nullptr;
    if (RegCreateKeyExW(
            HKEY_CURRENT_USER,
            L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VesperaClient",
            0, nullptr, 0, KEY_WRITE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
        auto setSz = [&](const wchar_t* name, const std::wstring& val) {
            RegSetValueExW(hKey, name, 0, REG_SZ,
                           reinterpret_cast<const BYTE*>(val.c_str()),
                           static_cast<DWORD>((val.size() + 1) * sizeof(wchar_t)));
        };
        setSz(L"DisplayName", L"Vespera Client");
        setSz(L"DisplayVersion", L"1.2.1");
        setSz(L"Publisher", L"Vespera Labs");
        setSz(L"DisplayIcon", iconPath.wstring());
        setSz(L"InstallLocation", installDir.wstring());
        setSz(L"UninstallString", L"\"" + uninstallExePath.wstring() + L"\"");
        setSz(L"QuietUninstallString", L"\"" + uninstallExePath.wstring() + L"\" /S");

        DWORD noModify = 1;
        DWORD estSizeKb = static_cast<DWORD>((kPayloadLauncherExeSize + kPayloadUninstallExeSize + kPayloadModJarSize) / 1024 + 64);
        RegSetValueExW(hKey, L"NoModify", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&noModify), sizeof(DWORD));
        RegSetValueExW(hKey, L"NoRepair", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&noModify), sizeof(DWORD));
        RegSetValueExW(hKey, L"EstimatedSize", 0, REG_DWORD, reinterpret_cast<const BYTE*>(&estSizeKb), sizeof(DWORD));
        RegCloseKey(hKey);
    }

    // 5. Create Desktop & Start Menu Shortcuts (.lnk)
    set_status_text(L"Creating Windows Start Menu & Desktop shortcuts...", 95);
    if (createDesktopShortcut) {
        fs::path desktopDir = fs::u8path(get_known_folder_utf8(FOLDERID_Desktop, ""));
        create_windows_shortcut(
            desktopDir / "Vespera Client.lnk",
            launcherExePath,
            installDir,
            iconPath,
            L"Vespera Client — High-Performance Minecraft Java Edition Client"
        );
    }
    if (createStartMenuShortcut) {
        fs::path startPrograms = fs::u8path(get_known_folder_utf8(FOLDERID_Programs, "")) / "Vespera Client";
        create_windows_shortcut(
            startPrograms / "Vespera Client.lnk",
            launcherExePath,
            installDir,
            iconPath,
            L"Launch Vespera Client"
        );
        create_windows_shortcut(
            startPrograms / "Uninstall Vespera Client.lnk",
            uninstallExePath,
            installDir,
            iconPath,
            L"Uninstall Vespera Client"
        );
    }

    set_status_text(L"Installation complete! Vespera Client v1.2.1 is ready.", 100);
    return true;
}

LRESULT CALLBACK SetupWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
        case WM_CREATE: {
            g_ui.hFontTitle = CreateFontW(-22, 0, 0, 0, FW_EXTRABOLD, FALSE, FALSE, FALSE,
                                          DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                          CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
            g_ui.hFontSubtitle = CreateFontW(-13, 0, 0, 0, FW_SEMIBOLD, FALSE, FALSE, FALSE,
                                             DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                             CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");
            g_ui.hFontBody = CreateFontW(-13, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE,
                                         DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                                         CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Segoe UI");

            HWND hTitle = CreateWindowExW(0, L"STATIC", L"VESPERA CLIENT v1.2.1 SETUP",
                                          WS_CHILD | WS_VISIBLE, 26, 20, 560, 30, hwnd, nullptr, nullptr, nullptr);
            SendMessageW(hTitle, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontTitle), TRUE);

            HWND hSub = CreateWindowExW(0, L"STATIC",
                                        L"High-Performance Minecraft Java Edition Client & Mod Manager for Windows 10 / 11 (64-bit)",
                                        WS_CHILD | WS_VISIBLE, 26, 52, 560, 22, hwnd, nullptr, nullptr, nullptr);
            SendMessageW(hSub, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontSubtitle), TRUE);

            HWND hDirLbl = CreateWindowExW(0, L"STATIC", L"Installation Folder (No Administrator UAC Required):",
                                           WS_CHILD | WS_VISIBLE, 26, 94, 420, 20, hwnd, nullptr, nullptr, nullptr);
            SendMessageW(hDirLbl, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);

            std::string localAppData = get_known_folder_utf8(FOLDERID_LocalAppData, "LOCALAPPDATA");
            std::wstring defaultInstall = (fs::u8path(localAppData) / "Programs" / "VesperaClient").wstring();

            g_ui.hwndDirEdit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", defaultInstall.c_str(),
                                               WS_CHILD | WS_VISIBLE | ES_AUTOHSCROLL,
                                               26, 118, 468, 26, hwnd, reinterpret_cast<HMENU>(IDC_DIR_EDIT), nullptr, nullptr);
            SendMessageW(g_ui.hwndDirEdit, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);

            HWND hBrowse = CreateWindowExW(0, L"BUTTON", L"Browse...",
                                           WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                                           504, 117, 88, 28, hwnd, reinterpret_cast<HMENU>(IDC_BROWSE_BTN), nullptr, nullptr);
            SendMessageW(hBrowse, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);

            g_ui.hwndChkDesktop = CreateWindowExW(0, L"BUTTON", L"Create Desktop Shortcut",
                                                  WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                                                  26, 162, 320, 22, hwnd, reinterpret_cast<HMENU>(IDC_CHK_DESKTOP), nullptr, nullptr);
            SendMessageW(g_ui.hwndChkDesktop, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);
            SendMessageW(g_ui.hwndChkDesktop, BM_SETCHECK, BST_CHECKED, 0);

            g_ui.hwndChkStartMenu = CreateWindowExW(0, L"BUTTON", L"Create Windows Start Menu Folder & Shortcuts",
                                                    WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                                                    26, 190, 380, 22, hwnd, reinterpret_cast<HMENU>(IDC_CHK_STARTMENU), nullptr, nullptr);
            SendMessageW(g_ui.hwndChkStartMenu, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);
            SendMessageW(g_ui.hwndChkStartMenu, BM_SETCHECK, BST_CHECKED, 0);

            g_ui.hwndChkLaunch = CreateWindowExW(0, L"BUTTON", L"Launch Vespera Client immediately after setup finishes",
                                                 WS_CHILD | WS_VISIBLE | BS_AUTOCHECKBOX,
                                                 26, 218, 420, 22, hwnd, reinterpret_cast<HMENU>(IDC_CHK_LAUNCH), nullptr, nullptr);
            SendMessageW(g_ui.hwndChkLaunch, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);
            SendMessageW(g_ui.hwndChkLaunch, BM_SETCHECK, BST_CHECKED, 0);

            g_ui.hwndStatus = CreateWindowExW(0, L"STATIC",
                                              L"Ready to install Vespera Client (Java runtimes are managed automatically — no manual Java/Git/Node setup needed).",
                                              WS_CHILD | WS_VISIBLE, 26, 262, 566, 36, hwnd, reinterpret_cast<HMENU>(IDC_STATUS_LBL), nullptr, nullptr);
            SendMessageW(g_ui.hwndStatus, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);

            g_ui.hwndProgress = CreateWindowExW(0, PROGRESS_CLASSW, nullptr,
                                                WS_CHILD | WS_VISIBLE | PBS_SMOOTH,
                                                26, 304, 566, 20, hwnd, reinterpret_cast<HMENU>(IDC_PROGRESS), nullptr, nullptr);
            SendMessageW(g_ui.hwndProgress, PBM_SETRANGE, 0, MAKELPARAM(0, 100));

            g_ui.hwndInstallBtn = CreateWindowExW(0, L"BUTTON", L"Install Vespera Client",
                                                  WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON,
                                                  338, 344, 154, 34, hwnd, reinterpret_cast<HMENU>(IDC_INSTALL_BTN), nullptr, nullptr);
            SendMessageW(g_ui.hwndInstallBtn, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontSubtitle), TRUE);

            HWND hCancel = CreateWindowExW(0, L"BUTTON", L"Cancel",
                                           WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON,
                                           502, 344, 90, 34, hwnd, reinterpret_cast<HMENU>(IDC_CANCEL_BTN), nullptr, nullptr);
            SendMessageW(hCancel, WM_SETFONT, reinterpret_cast<WPARAM>(g_ui.hFontBody), TRUE);
            return 0;
        }

        case WM_COMMAND: {
            int id = LOWORD(wParam);
            if (id == IDC_CANCEL_BTN) {
                PostQuitMessage(0);
                return 0;
            }
            if (id == IDC_BROWSE_BTN) {
                BROWSEINFOW bi{};
                bi.hwndOwner = hwnd;
                bi.lpszTitle = L"Select Destination Folder for Vespera Client:";
                bi.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
                PIDLIST_ABSOLUTE pidl = SHBrowseForFolderW(&bi);
                if (pidl) {
                    wchar_t chosen[MAX_PATH] = {};
                    if (SHGetPathFromIDListW(pidl, chosen)) {
                        fs::path full = fs::path(chosen) / "VesperaClient";
                        SetWindowTextW(g_ui.hwndDirEdit, full.wstring().c_str());
                    }
                    CoTaskMemFree(pidl);
                }
                return 0;
            }
            if (id == IDC_INSTALL_BTN) {
                EnableWindow(g_ui.hwndInstallBtn, FALSE);
                wchar_t dirBuf[MAX_PATH] = {};
                GetWindowTextW(g_ui.hwndDirEdit, dirBuf, MAX_PATH);
                fs::path targetDir(dirBuf);

                bool mkDesktop = (SendMessageW(g_ui.hwndChkDesktop, BM_GETCHECK, 0, 0) == BST_CHECKED);
                bool mkStart = (SendMessageW(g_ui.hwndChkStartMenu, BM_GETCHECK, 0, 0) == BST_CHECKED);
                bool launchNow = (SendMessageW(g_ui.hwndChkLaunch, BM_GETCHECK, 0, 0) == BST_CHECKED);

                std::wstring err;
                if (!execute_installation(targetDir, mkDesktop, mkStart, err)) {
                    MessageBoxW(hwnd, err.c_str(), L"Vespera Setup Error", MB_ICONERROR | MB_OK);
                    EnableWindow(g_ui.hwndInstallBtn, TRUE);
                    return 0;
                }

                MessageBoxW(
                    hwnd,
                    L"Vespera Client v1.2.1 has been installed!\n\nManaged data directory: %APPDATA%\\VesperaClient\nUninstaller registered in Windows Apps & Features.",
                    L"Setup Complete",
                    MB_ICONINFORMATION | MB_OK
                );

                if (launchNow) {
                    fs::path exePath = targetDir / "VesperaClient.exe";
                    ShellExecuteW(nullptr, L"open", exePath.wstring().c_str(), nullptr, targetDir.wstring().c_str(), SW_SHOWNORMAL);
                }
                PostQuitMessage(0);
                return 0;
            }
            break;
        }

        case WM_DESTROY:
            if (g_ui.hFontTitle) DeleteObject(g_ui.hFontTitle);
            if (g_ui.hFontSubtitle) DeleteObject(g_ui.hFontSubtitle);
            if (g_ui.hFontBody) DeleteObject(g_ui.hFontBody);
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

} // namespace

int WINAPI WinMain(HINSTANCE hInst, HINSTANCE, LPSTR lpCmdLine, int nCmdShow) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    INITCOMMONCONTROLSEX icc{ sizeof(icc), ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES };
    InitCommonControlsEx(&icc);

    std::string cmd = lpCmdLine ? lpCmdLine : "";
    if (cmd.find("/S") != std::string::npos || cmd.find("/s") != std::string::npos) {
        std::string localAppData = get_known_folder_utf8(FOLDERID_LocalAppData, "LOCALAPPDATA");
        fs::path targetDir = fs::u8path(localAppData) / "Programs" / "VesperaClient";
        auto dPos = cmd.find("/D=");
        if (dPos != std::string::npos) {
            targetDir = fs::u8path(cmd.substr(dPos + 3));
        }
        std::wstring err;
        bool ok = execute_installation(targetDir, true, true, err);
        CoUninitialize();
        return ok ? 0 : 1;
    }

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = SetupWndProc;
    wc.hInstance = hInst;
    wc.hIcon = LoadIconW(hInst, MAKEINTRESOURCEW(1));
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    wc.lpszClassName = L"VesperaSetupWizardWnd";
    RegisterClassExW(&wc);

    int screenW = GetSystemMetrics(SM_CXSCREEN);
    int screenH = GetSystemMetrics(SM_CYSCREEN);
    int winW = 630;
    int winH = 430;

    g_ui.hwndMain = CreateWindowExW(
        0,
        wc.lpszClassName,
        L"Vespera Client v1.2.1 — Windows 64-bit Setup",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        (screenW - winW) / 2,
        (screenH - winH) / 2,
        winW,
        winH,
        nullptr,
        nullptr,
        hInst,
        nullptr
    );

    ShowWindow(g_ui.hwndMain, nCmdShow);
    UpdateWindow(g_ui.hwndMain);

    MSG m{};
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }

    CoUninitialize();
    return 0;
}
