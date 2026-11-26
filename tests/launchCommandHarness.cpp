#include "launch_command.hpp"
#include "launch_diagnostics.hpp"
#include <cassert>
#include <string>
#include <vector>

int main() {
    using vespera::build_windows_command_line;
    using vespera::quote_windows_argument;

    assert(quote_windows_argument(L"plain") == L"\"plain\"");
    assert(quote_windows_argument(L"space here") == L"\"space here\"");
    assert(quote_windows_argument(L"quote\"inside") == L"\"quote\\\"inside\"");
    assert(quote_windows_argument(L"ends\\\\") == L"\"ends\\\\\\\\\"");

    const std::wstring command = build_windows_command_line(
        L"C:\\Program Files\\Java\\bin\\javaw.exe",
        {L"-Dgreeting=hello world", L"arg with \"quote\"", L"trailing\\"});
    assert(command == L"\"C:\\Program Files\\Java\\bin\\javaw.exe\" "
                      L"\"-Dgreeting=hello world\" "
                      L"\"arg with \\\"quote\\\"\" "
                      L"\"trailing\\\\\"");

    const std::string crashText = "[INFO] Starting client\njava.lang.RuntimeException: startup failed\nCaused by: java.lang.UnsatisfiedLinkError: missing native";
    assert(vespera::first_meaningful_exception(crashText) == "java.lang.RuntimeException: startup failed");
    assert(vespera::first_meaningful_exception("normal startup output\nWindow created").empty());
    assert(vespera::first_meaningful_exception("Could not find or load main class net.fabricmc.loader.impl.launch.knot.Client") ==
           "Could not find or load main class net.fabricmc.loader.impl.launch.knot.Client");
    assert(vespera::first_meaningful_exception("Mixin apply failed for mod example") ==
           "Mixin apply failed for mod example");
    return 0;
}
