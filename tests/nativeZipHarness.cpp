#include "native_zip.hpp"
#include "native_classifier.hpp"
#include <iostream>
int main(int argc, char** argv) {
    if (argc == 4 && std::string(argv[1]) == "--classifier")
        return vespera::windows_classifier_matches_target(argv[2], argv[3]) ? 0 : 2;
    if (argc < 3) return 64;
    std::vector<std::string> excludes;
    for (int i = 3; i < argc; ++i) excludes.emplace_back(argv[i]);
    try {
        const auto result = vespera::native_zip::extract_dlls(argv[1], argv[2], excludes);
        std::cout << "entries=" << result.entries << " extracted=" << result.extracted << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
