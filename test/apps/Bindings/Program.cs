using System.ComponentModel;
using System.Windows.Forms;

class Customer
{
    public string Name { get; set; } = "";
    public int Age { get; set; }
}

static class Program
{
    [System.STAThread]
    static void Main()
    {
        var customers = new BindingList<Customer> { new Customer { Name = "Alice", Age = 30 }, new Customer { Name = "Bob", Age = 40 } };
        var customerSource = new BindingSource { DataSource = customers };
        var form = new Form { Name = "customerForm", Text = "Bindings test", Width = 500, Height = 400 };
        var nameBox = new TextBox { Name = "nameBox", Left = 20, Top = 20 };
        nameBox.DataBindings.Add("Text", customerSource, "Name");
        var ageBox = new NumericUpDown { Name = "ageBox", Left = 20, Top = 50, Maximum = 200 };
        ageBox.DataBindings.Add("Value", customerSource, "Age", true, DataSourceUpdateMode.OnPropertyChanged);
        var panel = new Panel { Name = "detailPanel", Left = 20, Top = 80, Width = 300, Height = 40 };
        var ageLabel = new Label { Name = "ageLabel", Left = 0, Top = 0 };
        ageLabel.DataBindings.Add("Text", customerSource, "Age", true, DataSourceUpdateMode.Never, "", "Age: {0}");
        panel.Controls.Add(ageLabel);
        var combo = new ComboBox { Name = "customerCombo", Left = 20, Top = 130, DataSource = customers, DisplayMember = "Name", ValueMember = "Age" };
        var grid = new DataGridView { Name = "customerGrid", Left = 20, Top = 160, Width = 400, Height = 150, DataSource = customerSource };
        form.Controls.AddRange(new Control[] { nameBox, ageBox, panel, combo, grid });
        var timer = new Timer { Interval = 500 };
        timer.Tick += (s, e) =>
        {
            timer.Stop();
            customerSource.Position = 1;
            nameBox.Text = "Edited"; // not pushed to Bob yet: the binding updates the source on validation
            form.Close(); // @shown
        };
        form.Shown += (s, e) => timer.Start();
        Application.Run(form);
    }
}
