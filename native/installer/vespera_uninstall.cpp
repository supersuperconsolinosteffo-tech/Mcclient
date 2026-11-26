#include "../src/win32_platform.hpp"

namespace fs = std::filesystem;
using namespace vespera_win32;

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR lpCmdLine, int) {
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    std::string cmd = lpCmdLine ? lpCmdLine : "";
    bool silent = (cmd.find("/S") != std::string::npos || cmd.find("/s") != std::string::npos);

    if (!silent) {
        int confirm = MessageBoxW(
            nullptr,
            L"Are you sure you want to uninstall Vespera Client v1.1.1 from your computer?",
            L"Vespera Client Uninstaller",
            MB_ICONQUESTION | MB_YESNO | MB_DEFBUTTON2
        );
        if (confirm != IDYES) {
            CoUninitialize();
            return 0;
        }
    }

    bool removeUserData = false;
    if (!silent) {
        int keepAns = MessageBoxW(
            nullptr,
            L"Do you want to KEEP your Minecraft profiles, worlds, screenshots, and settings in %APPDATA%\\VesperaClient?\n\nClick YES to preserve your profiles and worlds (Recommended).\nClick NO to permanently delete all Vespera Client user data.",
            L"Preserve Minecraft Profiles & Worlds?",
            MB_ICONQUESTION | MB_YESNO | MB_DEFBUTTON1
        );
        removeUserData = (keepAns == IDNO);
    }

    // 1. Determine current installation folder from executable path
    wchar_t selfPathBuf[MAX_PATH] = {};
    GetModuleFileNameW(nullptr, selfPathBuf, MAX_PATH);
    fs::path selfExe(selfPathBuf);
    fs::path installDir = selfExe.parent_path();

    // 2. Remove Desktop & Start Menu shortcuts
    std::error_code ec;
    fs::path desktopDir = fs::u8path(get_known_folder_utf8(FOLDERID_Desktop, ""));
    fs::path programsDir = fs::u8path(get_known_folder_utf8(FOLDERID_Programs, ""));
    fs::remove(desktopDir / "Vespera Client.lnk", ec);
    fs::remove_all(programsDir / "Vespera Client", ec);

    // 3. Remove Windows Add/Remove Programs Registry key
    RegDeleteKeyW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VesperaClient");

    // 4. Optionally remove %APPDATA%\VesperaClient if user explicitly requested
    if (removeUserData) {
        fs::path appData = fs::u8path(get_known_folder_utf8(FOLDERID_RoamingAppData, "APPDATA")) / "VesperaClient";
        fs::remove_all(appData, ec);
    }

    // 5. Remove installed application files and schedule self-cleanup after exit
    fs::remove(installDir / "VesperaClient.exe", ec);
    fs::remove(installDir / "vespera.ico", ec);
    fs::remove(installDir / "LICENSE.txt", ec);
    fs::remove_all(installDir / "mods", ec);

    if (!silent) {
        MessageBoxW(
            nullptr,
            L"Vespera Client has been cleanly uninstalled.",
            L"Vespera Client Uninstaller",
            MB_ICONINFORMATION | MB_OK
        );
    }

    // Spawn brief delayed cleanup of VesperaUninstall.exe and empty install folder
    std::wstring cleanCmd = L"cmd.exe /C ping 127.0.0.1 -n 2 > nul & del /F /Q \"" +
                            selfExe.wstring() + L"\" & rmdir \"" + installDir.wstring() + L"\"";
    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (CreateProcessW(nullptr, cleanCmd.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }

    CoUninitialize();
    return 0;
}
