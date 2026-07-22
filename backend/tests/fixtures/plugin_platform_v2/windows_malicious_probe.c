#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

static int can_read(const wchar_t *path) {
    HANDLE file = CreateFileW(
        path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL
    );
    if (file == INVALID_HANDLE_VALUE) {
        return 0;
    }
    CloseHandle(file);
    return 1;
}

static int can_write(const wchar_t *path) {
    HANDLE file = CreateFileW(
        path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL
    );
    if (file == INVALID_HANDLE_VALUE) {
        return 0;
    }
    const char payload[] = "sandbox-probe";
    DWORD written = 0;
    WriteFile(file, payload, (DWORD)(sizeof(payload) - 1), &written, NULL);
    CloseHandle(file);
    return 1;
}

static int direct_network_error(const char *address, unsigned short port) {
    WSADATA data;
    int startup_error = WSAStartup(MAKEWORD(2, 2), &data);
    if (startup_error != 0) {
        return startup_error;
    }
    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        int error = WSAGetLastError();
        WSACleanup();
        return error;
    }
    struct sockaddr_in target;
    ZeroMemory(&target, sizeof(target));
    target.sin_family = AF_INET;
    target.sin_port = htons(port);
    InetPtonA(AF_INET, address, &target.sin_addr);
    u_long nonblocking = 1;
    ioctlsocket(sock, FIONBIO, &nonblocking);
    int result = connect(sock, (struct sockaddr *)&target, sizeof(target));
    int error = result == SOCKET_ERROR ? WSAGetLastError() : 0;
    if (result == SOCKET_ERROR &&
        (error == WSAEWOULDBLOCK || error == WSAEINPROGRESS ||
         error == WSAEALREADY)) {
        fd_set writable;
        fd_set exceptional;
        FD_ZERO(&writable);
        FD_ZERO(&exceptional);
        FD_SET(sock, &writable);
        FD_SET(sock, &exceptional);
        struct timeval timeout = {1, 0};
        result = select(0, NULL, &writable, &exceptional, &timeout);
        if (result == 0) {
            error = WSAETIMEDOUT;
        } else if (result == SOCKET_ERROR) {
            error = WSAGetLastError();
        } else {
            int socket_error = 0;
            int length = sizeof(socket_error);
            if (getsockopt(sock, SOL_SOCKET, SO_ERROR,
                           (char *)&socket_error, &length) == SOCKET_ERROR) {
                error = WSAGetLastError();
            } else {
                error = socket_error;
            }
        }
    }
    closesocket(sock);
    WSACleanup();
    return error;
}

static int child_process_denied(void) {
    wchar_t command[] = L"C:\\Windows\\System32\\cmd.exe /d /c exit 0";
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    if (CreateProcessW(NULL, command, NULL, NULL, FALSE, CREATE_NO_WINDOW,
                       NULL, NULL, &startup, &process)) {
        CloseHandle(process.hThread);
        TerminateProcess(process.hProcess, 91);
        CloseHandle(process.hProcess);
        return 0;
    }
    return 1;
}

static int is_appcontainer(void) {
    HANDLE token = NULL;
    DWORD value = 0;
    DWORD returned = 0;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        return 0;
    }
    int ok = GetTokenInformation(
        token, (TOKEN_INFORMATION_CLASS)29, &value, sizeof(value), &returned
    );
    CloseHandle(token);
    return ok && value != 0;
}

static int is_in_job(void) {
    BOOL value = FALSE;
    return IsProcessInJob(GetCurrentProcess(), NULL, &value) && value;
}

static unsigned long long memory_ceiling_probe(void) {
    void *blocks[512];
    unsigned long long allocated = 0;
    ZeroMemory(blocks, sizeof(blocks));
    for (int index = 0; index < 512; ++index) {
        blocks[index] = VirtualAlloc(
            NULL, 1024 * 1024, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE
        );
        if (blocks[index] == NULL) {
            break;
        }
        memset(blocks[index], index, 1024 * 1024);
        allocated += 1024 * 1024;
    }
    for (int index = 0; index < 512; ++index) {
        if (blocks[index] != NULL) {
            VirtualFree(blocks[index], 0, MEM_RELEASE);
        }
    }
    return allocated;
}

static int run_disk_probe(const wchar_t *path) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return 31;
    }
    char *block = (char *)malloc(65536);
    if (block == NULL) {
        CloseHandle(file);
        return 32;
    }
    memset(block, 'D', 65536);
    for (;;) {
        DWORD written = 0;
        if (!WriteFile(file, block, 65536, &written, NULL) || written != 65536) {
            break;
        }
        FlushFileBuffers(file);
    }
    free(block);
    CloseHandle(file);
    return 33;
}

static int write_pid(const wchar_t *path) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return 0;
    }
    char text[32];
    int length = snprintf(text, sizeof(text), "%lu", GetCurrentProcessId());
    DWORD written = 0;
    int ok = length > 0 && WriteFile(file, text, (DWORD)length, &written, NULL) &&
             written == (DWORD)length;
    CloseHandle(file);
    return ok;
}

static int run_stderr_probe(const wchar_t *pid_path) {
    if (pid_path != NULL && !write_pid(pid_path)) {
        return 41;
    }
    char block[4096];
    memset(block, 'S', sizeof(block));
    for (int index = 0; index < 1024; ++index) {
        fwrite(block, 1, sizeof(block), stderr);
        fflush(stderr);
        Sleep(1);
    }
    return 0;
}

static int run_cpu_probe(void) {
    volatile unsigned long long value = 1;
    for (;;) {
        value = value * 6364136223846793005ULL + 1442695040888963407ULL;
    }
}

int wmain(int argc, wchar_t **argv) {
    if (argc >= 3 && wcscmp(argv[1], L"disk") == 0) {
        return run_disk_probe(argv[2]);
    }
    if (argc >= 2 && wcscmp(argv[1], L"stderr") == 0) {
        return run_stderr_probe(argc >= 3 ? argv[2] : NULL);
    }
    if (argc >= 2 && wcscmp(argv[1], L"cpu") == 0) {
        return run_cpu_probe();
    }
    if (argc != 7 || wcscmp(argv[1], L"attack") != 0) {
        fwprintf(stderr, L"usage: probe attack SECRET SOURCE INSTALL_WRITE PRIVATE_WRITE LOOPBACK_PORT\n");
        return 2;
    }
    int secret_read = can_read(argv[2]);
    int source_read = can_read(argv[3]);
    int installation_write = can_write(argv[4]);
    int private_write = can_write(argv[5]);
    int loopback_error = direct_network_error(
        "127.0.0.1", (unsigned short)_wtoi(argv[6])
    );
    int external_error = direct_network_error("1.1.1.1", 53);
    int loopback_denied = loopback_error != 0;
    int external_denied = external_error != 0;
    int child_denied = child_process_denied();
    int appcontainer = is_appcontainer();
    int in_job = is_in_job();
    unsigned long long allocated = memory_ceiling_probe();
    printf(
        "{\"secretRead\":%s,\"sourceRead\":%s,\"installationWrite\":%s,"
        "\"privateWrite\":%s,\"loopbackDenied\":%s,\"externalDenied\":%s,"
        "\"loopbackError\":%d,\"externalError\":%d,"
        "\"childProcessDenied\":%s,\"appContainer\":%s,\"inJob\":%s,"
        "\"allocatedBytes\":%llu}\n",
        secret_read ? "true" : "false",
        source_read ? "true" : "false",
        installation_write ? "true" : "false",
        private_write ? "true" : "false",
        loopback_denied ? "true" : "false",
        external_denied ? "true" : "false",
        loopback_error,
        external_error,
        child_denied ? "true" : "false",
        appcontainer ? "true" : "false",
        in_job ? "true" : "false",
        allocated
    );
    fflush(stdout);
    return 0;
}
