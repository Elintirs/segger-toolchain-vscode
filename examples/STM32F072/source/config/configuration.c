#include "stm32f072xb.h"
#include "utils/stm32f072xb_ext.h"

#include "configuration.h"

#define alfa	b0
#define betta	b1
#define rc		b2
#define r		b3

#define Major (uint8_t) 1
#define Minor (uint8_t) 0
#define Patch (uint8_t) 0

const volatile u8 version[4] = {Major, Minor, Patch, alfa}; // 1.0.0 alfa
/*
	byte0 - Major значительное изменение (полность переписан модуль или блок)
	byte1 - Minor новые функции совместимые с прошлой версией
	byte2 - Patch мелкое исправление ошибок
	byte3 Stage (bit flag):

	b0 - alfa
	b1 - betta
	b2 - rc (release candidate) базовая версия программы
	b3 - r  (for commercial distribution) версия для коммерческого распространения
	b4 - r5 (for commercial distribution with many bugs fixed) для коммерческого распространения с последними правками

*/


