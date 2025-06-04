"""
Settings for how to run the app in a production environment using the WSGI standard for how web servers communicate with web applications.
Run with gunicorn, e.g.
gunicorn --config gunicorn_config.py --bind 0.0.0.0:8080 wsgi:main
"""

from response_bot import main  # alias the main function

if __name__ == "__main__":
    # run the bot!
    main()
