{
    "variables": {"veriq_native_tests%": 0},
    "targets": [
        {
            "target_name": "veriq_native",
            "sources": ["windows-addon.cc"],
            "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
            "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9", "_WIN32_WINNT=0x0A00"],
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "AdditionalOptions": ["/std:c++17", "/utf-8", "/W4"],
                    "ExceptionHandling": 1
                }
            },
            "libraries": ["Advapi32.lib"]
        },
        {
            "target_name": "veriq_guardian",
            "type": "executable",
            "win_delay_load_hook": "false",
            "sources": ["windows-guardian.cc"],
            "defines": ["_WIN32_WINNT=0x0A00"],
            "msvs_settings": {
                "VCCLCompilerTool": {
                    "AdditionalOptions": ["/std:c++17", "/utf-8", "/W4"],
                    "ExceptionHandling": 1
                }
            },
            "libraries": ["Advapi32.lib"]
        }
    ],
    "conditions": [
        ["veriq_native_tests==1", {
            "targets": [
                {
                    "target_name": "veriq_guardian_scheduled",
                    "type": "executable",
                    "win_delay_load_hook": "false",
                    "sources": ["../tests/native/windows-guardian-scheduled.cc"],
                    "defines": ["_WIN32_WINNT=0x0A00"],
                    "msvs_settings": {
                        "VCCLCompilerTool": {
                            "AdditionalOptions": ["/std:c++17", "/utf-8", "/W4"],
                            "ExceptionHandling": 1
                        }
                    },
                    "libraries": ["Advapi32.lib"]
                },
                {
                    "target_name": "veriq_test_schedule",
                    "sources": ["../tests/native/windows-schedule-addon.cc"],
                    "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
                    "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=9", "_WIN32_WINNT=0x0A00"],
                    "msvs_settings": {
                        "VCCLCompilerTool": {
                            "AdditionalOptions": ["/std:c++17", "/utf-8", "/W4"],
                            "ExceptionHandling": 1
                        }
                    },
                    "libraries": ["Advapi32.lib"]
                }
            ]
        }]
    ]
}
