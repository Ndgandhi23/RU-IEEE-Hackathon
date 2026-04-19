import RPi.GPIO as GPIO
import time
import curses

# BCM pin numbering
IN1 = 17
IN2 = 27
IN3 = 22
IN4 = 23

GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)

GPIO.setup(IN1, GPIO.OUT)
GPIO.setup(IN2, GPIO.OUT)
GPIO.setup(IN3, GPIO.OUT)
GPIO.setup(IN4, GPIO.OUT)

def forward():
    # Motor A forward
    GPIO.output(IN1, GPIO.HIGH)
    GPIO.output(IN2, GPIO.LOW)

    # Motor B forward
    GPIO.output(IN3, GPIO.HIGH)
    GPIO.output(IN4, GPIO.LOW)
    
def backward():
    GPIO.output(IN1, GPIO.LOW)
    GPIO.output(IN2, GPIO.HIGH)
    GPIO.output(IN3, GPIO.LOW)
    GPIO.output(IN4, GPIO.HIGH)

def left():
    GPIO.output(IN1, GPIO.LOW)
    GPIO.output(IN2, GPIO.HIGH)
    GPIO.output(IN3, GPIO.HIGH)
    GPIO.output(IN4, GPIO.LOW)
    
def right():
    GPIO.output(IN1, GPIO.HIGH)
    GPIO.output(IN2, GPIO.LOW)
    GPIO.output(IN3, GPIO.LOW)
    GPIO.output(IN4, GPIO.HIGH)
    
def stop():
    GPIO.output(IN1, GPIO.LOW)
    GPIO.output(IN2, GPIO.LOW)
    GPIO.output(IN3, GPIO.LOW)
    GPIO.output(IN4, GPIO.LOW)

def main(stdscr):
    curses.curs_set(0)
    stdscr.nodelay(True)
    stdscr.timeout(50)
    stdscr.clear()
    
    curses.mousemask(0)
    stdscr.clear()
    stdscr.refresh()
    
    stdscr.addstr(0,0, "Robot keyboard control")
    stdscr.addstr(2,0, "w = forward")
    stdscr.addstr(3,0, "s = backward")
    stdscr.addstr(4,0, "a = left")
    stdscr.addstr(5,0, "d = right")
    stdscr.addstr(6,0, "x = stop")
    stdscr.addstr(7,0, "q = quit")
    stdscr.addstr(8,0, "no input = stop")
    stdscr.refresh()
    
    while True:
        key = stdscr.getch()
        
        if key == ord('w'):
            forward()
            
        elif key == ord('s'):
            backward()
            
        elif key == ord('a'):
            left()
            
        elif key == ord('d'):
            right()
            
        elif key == ord('x'):
            stop()
        elif key == ord('q'):
            stop()
            break
        else:
            stop()
            
        stdscr.refresh()

try:
    curses.wrapper(main)

finally:
    stop()
    GPIO.cleanup()
