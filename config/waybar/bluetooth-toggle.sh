#!/bin/bash

status=$(bluetoothctl show | grep "Powered:" | awk '{print $2}')

if [ "$status" = "yes" ]; then
    bluetoothctl power off
    notify-send "Bluetooth" "Выключен"
else
    bluetoothctl power on
    notify-send "Bluetooth" "Включен"
fi
