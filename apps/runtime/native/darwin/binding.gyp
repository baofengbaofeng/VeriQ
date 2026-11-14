{
    "variables": { "veriq_native_tests%": 0 },
    "target_defaults": {
        "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
        "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9"],
        "cflags!": ["-fno-exceptions"],
        "cflags_cc!": ["-fno-exceptions"],
        "cflags_cc": ["-std=c++17", "-stdlib=libc++", "-fexceptions"],
        "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "15.0",
            "OTHER_CPLUSPLUSFLAGS": ["-fexceptions"]
        }
    },
    "targets": [
        {
            "target_name": "veriq_private_files",
            "sources": ["addon.cc"],
            "xcode_settings": {
                "MACOSX_DEPLOYMENT_TARGET": "15.0",
                "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
                "CLANG_CXX_LIBRARY": "libc++",
                "OTHER_CPLUSPLUSFLAGS": ["-fexceptions"]
            }
        }
    ],
    "conditions": [
        ["veriq_native_tests==1", {
            "targets": [{
                "target_name": "veriq_private_files_fault",
                "sources": ["../../tests/native/darwin-private-files-fault.cc"],
                "xcode_settings": {
                    "MACOSX_DEPLOYMENT_TARGET": "15.0",
                    "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
                    "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
                    "CLANG_CXX_LIBRARY": "libc++",
                    "OTHER_CPLUSPLUSFLAGS": ["-fexceptions"]
                }
            }]
        }]
    ]
}
