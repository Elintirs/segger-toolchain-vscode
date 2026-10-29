
#include "stm32f072xb.h"
#include "utils/stm32f072xb_ext.h"
#include "config/configuration.h"

#include "config/system_init.h"
#include "main.h"


static volatile u16 __ALIGNED(2) cnt_led;
static volatile u8 switch_value;


int main(void) 
{
	GPIOA->BSRR = b8; // зелёный на статусе

	clock_init();
	gpio_init();
	led_init();
	rtc_init();

	cnt_led = 0;
	switch_value = 0;

	//GPIOA->BRR = b0;

	GPIOA->BRR = b7; 
	GPIOA->BSRR = b8; // зелёный на статусе

	
	GPIOA->BRR = b1;
	GPIOA->BRR = b2;
	GPIOA->BRR = b3;
	GPIOA->BRR = b4;
	GPIOA->BRR = b5;
	GPIOA->BRR = b6;
	
	__NVIC_EnableIRQ(RTC_IRQn);
	//SCB->SCR &= ~SCB_SCR_SLEEPDEEP_Msk;	// потом установить sleep deep msk чтобы он уходил в сон
	__enable_irq();

	while(1)
	{
		//__WFI();
		//__NOP();
	}

	return 0;
}

void RTC_IRQHandler(void)
{
	RTC->ISR &= ~RTC_ISR_WUTF;	// гасим флаг пробуждения от RTC (Wake-Up rTc Flag (WUTF))
	EXTI->PR |= EXTI_PR_PR20;	// гасим флаг RTC wake-up Exti line interrupt

	

	if(cnt_led == 0)	// green
	{
		GPIOA->BRR = b0;
		GPIOA->BRR = b7;
		GPIOA->BSRR = b8;		
	}

	if(cnt_led == 250) // red
	{
		GPIOA->BSRR = b0;
		GPIOA->BSRR = b7;
		GPIOA->BRR = b8;
	}

	cnt_led++;

	if(cnt_led >= 500)
	{
		cnt_led = 0;
	}
}
