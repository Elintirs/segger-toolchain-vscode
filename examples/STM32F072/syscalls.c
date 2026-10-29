#include <sys/types.h>

int _close(int file) {
    return -1;
}

int _lseek(int file, int ptr, int dir) {
    return 0;
}

int _read(int file, char *ptr, int len) {
    return 0;
}

int _write(int file, char *ptr, int len) {
    // Оставляем пустым или позже добавим вывод в регистр USART1->TDR
    return len;
}

void _exit(int status) {
    while (1);
}