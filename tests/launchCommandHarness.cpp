#include "launch_command.hpp"
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
    return 0;
}
