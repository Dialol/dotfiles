#!/bin/bash

chosen=$(echo -e "⏻ Power off\n Reboot\n Suspend\n Hibernate" | rofi -dmenu -i -p "Power menu" -theme ~/.config/rofi/power-menu.rasi) 

case "$chosen" in
    "⏻ Power off") systemctl poweroff ;;
    " Reboot") systemctl reboot ;;
    " Suspend") systemctl suspend ;;
    " Hibernate") systemctl hibernate ;;
    *) exit 0 ;;
esac
