#include "stm32f072xb.h"
#include "utils/stm32f072xb_ext.h"
#include "configuration.h"

#include"system_init.h"

void clock_init(void)
{
	RCC->CR |= RCC_CR_HSION;

	while ((RCC->CR&RCC_CR_HSIRDY) == 0) { continue; }

	RCC->CFGR &= ~RCC_CFGR_SW;	// hsi as core cortex
	
	while ((RCC->CFGR & RCC_CFGR_SWS) != 0) { continue; }

	RCC->CR &= ~(RCC_CR_PLLON | RCC_CR_CSSON | RCC_CR_HSEBYP); // PLL_OFF, CSS_OFF, HSE_OFF

	RCC->CFGR = 0; // все множители тактирований выключены

	// Disable all interrupts and clear pending bits
	RCC->CIR = (
		RCC_CIR_CSSC		|	// w 23 CSSC  ready interrupt clear
		RCC_CIR_HSI48RDYC	|	// w 22 HSI14 ready interrupt clear
		RCC_CIR_HSI14RDYC	|	// w 21 HSI   ready interrupt clear
		RCC_CIR_PLLRDYC		|	// w 20 PLL   ready interrupt clear
		RCC_CIR_HSERDYC		|	// w 19 HSE   ready interrupt clear
		RCC_CIR_HSIRDYC		|	// w 18 HSI   ready interrupt clear
		RCC_CIR_LSERDYC		|	// w 17 LSE   ready interrupt clear
		RCC_CIR_LSIRDYC			// w 16 LSI   ready interrupt clear
	);

	RCC->CR2 = 0;	// потом надо будет включить тут HSI48_ON (скорее всего включать при exti на пине)
	RCC->AHBENR = 0;// устанавливаем тактирование выводов в gpio (при инициализации ставим 0)
	RCC->APB1ENR = 0; // устанавливаем тактирование переферии 0 при инициализации
	RCC->APB2ENR = 0; // устанавливаем тактирование переферии 0 при инициализации
	RCC->CFGR2 = 0;	// PREDIV not devided
	RCC->CFGR3 = 0; // set based (dafault) clock selection
	RCC->CSR = 0; // тут интересные флаги потом почитать подробнее

//	чистим регистр управления доступок к flash памяти
	FLASH->ACR = 0; // так как частота 8 МГц не требуется устанавливать делители LATENCY
//

	PWR->CR = 0; // чистим биты регистра cr (чистим бит PDDS)
	PWR->CR |= PWR_CR_LPDS;	// устанавливаем бит LPDS чтобы перейти в режим stop mode
	SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;	// утанавливаем бит SLEEPDEEP 
//
	EXTI->PR = 0;	// делаем ресет всех pending line EXTI

	EXTI->IMR = EXTI_IMR_MR20;	// разрешаем маску линии 20 для пробуждения по прерыванию RTC
	EXTI->RTSR = EXTI_RTSR_TR20;// указываем что реагировать на возрастающий фронт
//
}

void gpio_init(void)
{
	RCC->AHBENR |= RCC_AHBENR_GPIOAEN |RCC_AHBENR_GPIOBEN | RCC_AHBENR_GPIOCEN;

	GPIOA->MODER = 0x00000000;
	GPIOB->MODER = 0x00000000;
	GPIOC->MODER = 0x00000000;

	GPIOA->OTYPER = 0x00000000;
	GPIOB->OTYPER = 0x00000000;
	GPIOC->OTYPER = 0x00000000;

	GPIOA->OSPEEDR = 0x00000000;
	GPIOB->OSPEEDR = 0x00000000;
	GPIOC->OSPEEDR = 0x00000000;

	GPIOA->PUPDR = 0xAAAAAAAA;
	GPIOB->PUPDR = 0xAAAAAAAA;
	GPIOC->PUPDR = 0xAAAAAAAA;	
}

void led_init(void)
{
	// инициализации выводов индикации

	// led_button PA0 (для индикации состояний меняет тип подсветки кнопки)
	GPIOA->MODER |= GPIO_MODER_MODER0_0; // PA0 led_button
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR0);

	// led_1 - led_6 - светодиоды портов для дистракторов PA1- PA6

	//PA1
	GPIOA->MODER |= GPIO_MODER_MODER1_0; // PA1
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR1);

	//PA2
	GPIOA->MODER |= GPIO_MODER_MODER2_0; // PA2
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR2);

	//PA3
	GPIOA->MODER |= GPIO_MODER_MODER3_0; // PA3
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR3);

	//PA4
	GPIOA->MODER |= GPIO_MODER_MODER4_0; // PA4
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR4);

	//PA5
	GPIOA->MODER |= GPIO_MODER_MODER5_0; // PA5
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR5);

	//PA6
	GPIOA->MODER |= GPIO_MODER_MODER6_0; // PA6
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR6);


	// Подача на выводы значения
	GPIOA->MODER |= GPIO_MODER_MODER7_0; // PA7 r_comm
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR7);


	GPIOA->MODER |= GPIO_MODER_MODER8_0; // PA8 g_comm
	GPIOA->PUPDR &= ~(GPIO_PUPDR_PUPDR8);

	GPIOA->ODR = (b8 | b7 | b6 | b5 | b4 | b3 | b2 | b1 | b0); // set 1 on PA0 - PA8
}

void rtc_init(void)
{
	// настраиваем выводы GPIO в аналоговый вход
	GPIOC->MODER |= (GPIO_MODER_MODER15_1 | GPIO_MODER_MODER15_0 | GPIO_MODER_MODER14_1 | GPIO_MODER_MODER14_0);
	GPIOC->PUPDR &= ~(GPIO_PUPDR_PUPDR15 | GPIO_PUPDR_PUPDR14);

	RCC->APB1ENR |= RCC_APB1ENR_PWREN;	// тут настраиваем тактирование от HSI на шину APB1

	PWR->CR |= PWR_CR_DBP;	// enable rtc registers change открываем rtc регистр для записи бит

	RCC->BDCR = RCC_BDCR_BDRST;	// rtc domain reset 

	RCC->BDCR = RCC_BDCR_LSEON;	// 32k lse for rtc

	// while (!(RCC->BDCR & RCC_BDCR_LSERDY)) { continue; }
	while ((RCC->BDCR & RCC_BDCR_LSERDY) == 0) { continue; } // ожидаем запуска LSE (внешнего часового кварца)

	RCC->BDCR |= RCC_BDCR_RTCEN | RCC_BDCR_RTCSEL_LSE; // RCC_BDCR_RTCSEL_LSE - устанавливаем режим пробуждения по событию RTC таймера тактируемого от внешнего кварца LSE 32768 Hz
//
	// вводим пароль чтобы разлочить регистры RTC для записи
	RTC->WPR = 0xca;
	RTC->WPR = 0x53;

	RTC->CR &= ~RTC_CR_WUTE;
	//while (!(RTC->ISR & RTC_ISR_WUTWF)) { continue; }
	while ((RTC->ISR & RTC_ISR_WUTWF) == 0) { continue; }

	// настраиваем счётчик для wake-up режима
	RTC->WUTR = 7;	// 2048hz / 8 = 256hz int
	RTC->CR = 0;	// clock = 1/16, or 2048hz per counter tick

	RTC->ISR = 0;	// чистим регистр флагов событий

	RTC->CR = RTC_CR_WUTE | RTC_CR_WUTIE; // устанавливаем бит WUTE в конце инициализации RTC таймера, WUTIE - разрешаем прерывание

	RTC->WPR = 0xff; // вводим пароль чтобы запретить запись в регистры rtc
}

